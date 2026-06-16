import { Blaze, Blockfrost, Core, Provider } from "@blaze-cardano/sdk";

import { logger } from "../logger.js";

/**
 * Minimal CIP-30 wallet API shape this SDK actually uses.
 *
 * Defined locally rather than re-using @blaze-cardano/wallet's CIP30Interface
 * because the upstream type narrows getUtxos/getCollateral to `string[] | undefined`,
 * while @sundaeswap/wallet-lite (the de-facto consumer) types them as
 * `string[] | null`. Both are valid per CIP-30; we accept both with `null | undefined`.
 */
export interface BrowserWalletApi {
  getNetworkId(): Promise<number>;
  getUtxos(): Promise<string[] | null | undefined>;
  getCollateral?(): Promise<string[] | null | undefined>;
  getChangeAddress(): Promise<string>;
  getRewardAddresses(): Promise<string[]>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
  signData(
    address: string,
    payload: string,
  ): Promise<{ signature: string; key: string }>;
  submitTx(tx: string): Promise<string>;
}
// Ogmios purpose names to Blaze RedeemerTag mapping
const ogmiosPurposeToTag: Record<string, number> = {
  spend: 0,
  mint: 1,
  certificate: 2,
  withdraw: 3,
};

/** `<txId>#<index>` identifier for a UTxO reference. */
const utxoRefId = (utxo: Core.TransactionUnspentOutput): string =>
  `${utxo.input().transactionId()}#${utxo.input().index()}`;

/** Convert a bigint quantity to a JSON-safe number, throwing if it overflows. */
const toJsonSafeNumber = (value: bigint, what: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) {
    throw new Error(
      `createOgmiosEvaluator: ${what} (${value}) exceeds JSON-safe integer range`,
    );
  }
  return Number(value);
};

/**
 * Serialize a UTxO into Ogmios v6's `additionalUtxo` JSON shape
 * (cardano.json#/definitions/Utxo). Script refs are not serialized — the
 * UTxOs we supplement are chained wallet/script outputs which never carry
 * reference scripts in this protocol's flows.
 */
export const serializeUtxoForOgmios = (
  utxo: Core.TransactionUnspentOutput,
): Record<string, unknown> => {
  const output = utxo.output();

  const value: Record<string, unknown> = {
    ada: { lovelace: toJsonSafeNumber(output.amount().coin(), "lovelace") },
  };
  const multiasset = output.amount().multiasset();
  if (multiasset) {
    for (const [assetId, quantity] of multiasset) {
      const policy = String(assetId).slice(0, 56);
      const assetName = String(assetId).slice(56);
      const byPolicy = (value[policy] ?? {}) as Record<string, number>;
      byPolicy[assetName] = toJsonSafeNumber(
        quantity,
        `asset quantity for ${policy}.${assetName}`,
      );
      value[policy] = byPolicy;
    }
  }

  const entry: Record<string, unknown> = {
    transaction: { id: utxo.input().transactionId() },
    index: toJsonSafeNumber(utxo.input().index(), "output index"),
    address: output.address().toBech32(),
    value,
  };

  // Datum: inline (kind 1) or hash-only (kind 0); never both.
  const datum = output.datum() as
    | {
        kind?: () => number;
        asInlineData?: () => { toCbor(): string } | undefined;
        asDataHash?: () => string | undefined;
      }
    | undefined;
  if (datum && typeof datum.kind === "function") {
    if (datum.kind() === 1) {
      const inline = datum.asInlineData?.();
      if (inline) entry.datum = inline.toCbor();
    } else if (datum.kind() === 0) {
      const hash = datum.asDataHash?.();
      if (hash) entry.datumHash = String(hash);
    }
  }

  if (output.scriptRef()) {
    logger.warn(
      `createOgmiosEvaluator: UTxO ${utxoRefId(utxo)} carries a reference ` +
        `script which is not serialized into additionalUtxo — evaluation ` +
        `may fail if the script is required and unknown to the node`,
    );
  }

  return entry;
};

/**
 * Pull `<txId>#<index>` references out of an Ogmios "Unknown transaction
 * input (missing from UTxO set)" error payload.
 */
export const extractMissingUtxoRefs = (errorText: string): string[] => {
  const matches = errorText.match(/[0-9a-f]{64}#\d+/g) ?? [];
  return [...new Set(matches)];
};

const OGMIOS_EVAL_TIMEOUT_MS = 15000;
const MAX_EVALUATION_ATTEMPTS = 3;

interface OgmiosEvaluation {
  validator?: { purpose?: string; index?: number };
  budget: { memory: number; cpu: number };
}

/** One evaluateTransaction round-trip over a fresh WebSocket. */
const evaluateOnce = (
  ogmiosUrl: string,
  txCbor: string,
  additionalUtxo: Record<string, unknown>[],
): Promise<OgmiosEvaluation[]> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(ogmiosUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Ogmios evaluation timeout"));
    }, OGMIOS_EVAL_TIMEOUT_MS);

    ws.onopen = () => {
      const request = {
        jsonrpc: "2.0",
        method: "evaluateTransaction",
        params: {
          transaction: { cbor: txCbor },
          ...(additionalUtxo.length > 0 ? { additionalUtxo } : {}),
        },
        id: `eval-${Date.now()}`,
      };
      ws.send(JSON.stringify(request));
    };

    ws.onmessage = (event) => {
      clearTimeout(timeout);
      ws.close();
      try {
        const response = JSON.parse(event.data);
        if (response.error) {
          reject(
            new Error(
              `Ogmios evaluation failed: ${JSON.stringify(response.error)}`,
            ),
          );
          return;
        }
        resolve(response.result as OgmiosEvaluation[]);
      } catch (e) {
        reject(e);
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(new Error(`Ogmios WebSocket error: ${err}`));
    };
  });

/**
 * Creates an Ogmios-based evaluator with mempool access AND additional-UTxO
 * supplementation for transaction chaining.
 *
 * Chained transactions spend outputs of a just-submitted transaction. When
 * that transaction was submitted through a different path (wallet backend,
 * Blockfrost) there is a window where this Ogmios node has it in neither its
 * ledger UTxO set nor its mempool, and evaluation fails with "Unknown
 * transaction input". Rather than always sending `additionalUtxo` (which
 * risks `OverlappingAdditionalUtxo` rejections for UTxOs the node DOES
 * know), we evaluate optimistically, parse any missing-input error, and
 * retry supplying just the missing UTxOs from the provided set.
 *
 * @param ogmiosUrl - WebSocket URL for Ogmios (e.g., ws://localhost:1337 or wss://ogmios.example.com)
 */
export function createOgmiosEvaluator(ogmiosUrl: string): Core.Evaluator {
  if (!ogmiosUrl) {
    throw new Error(
      "Ogmios URL is required. Pass it as a parameter or set COSPONSOR_OGMIOS_URL environment variable.",
    );
  }

  return async (
    tx: Core.Transaction,
    additionalUtxos: Core.TransactionUnspentOutput[],
  ): Promise<Core.Redeemers> => {
    const txCbor = tx.toCbor();

    // UTxOs we can supplement when the node reports a missing input —
    // typically wallet UTxOs (incl. pending chained outputs) merged in by
    // the caller (e.g. the UI's wrapEvaluatorWithWalletUtxos).
    const available = new Map<string, Core.TransactionUnspentOutput>();
    for (const utxo of additionalUtxos ?? []) {
      available.set(utxoRefId(utxo), utxo);
    }
    const included = new Map<string, Record<string, unknown>>();

    logger.debug("Evaluating transaction with Ogmios (mempool-aware)...");

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_EVALUATION_ATTEMPTS; attempt++) {
      try {
        const evaluations = await evaluateOnce(ogmiosUrl, txCbor, [
          ...included.values(),
        ]);
        logger.debug("Ogmios evaluation result:", evaluations);
        return applyEvaluationsToRedeemers(tx, evaluations);
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const missing = extractMissingUtxoRefs(message);
        const supplementable = missing.filter(
          (ref) => available.has(ref) && !included.has(ref),
        );
        if (supplementable.length === 0) {
          throw error;
        }
        for (const ref of supplementable) {
          included.set(ref, serializeUtxoForOgmios(available.get(ref)!));
        }
        logger.debug(
          `Ogmios reported missing input(s) [${missing.join(", ")}]; ` +
            `retrying with ${included.size} additionalUtxo entr${included.size === 1 ? "y" : "ies"}...`,
        );
      }
    }
    throw lastError;
  };
}

/** Map Ogmios evaluation budgets back onto the transaction's redeemers. */
const applyEvaluationsToRedeemers = (
  tx: Core.Transaction,
  evaluations: OgmiosEvaluation[],
): Core.Redeemers => {
  // Get existing redeemers from transaction (as array via values())
  const currentRedeemers = tx.witnessSet().redeemers()?.values();

  if (!currentRedeemers || currentRedeemers.length === 0) {
    throw new Error("evaluateTransaction: No Redeemers found in transaction");
  }

  // Update each redeemer with execution units from Ogmios
  const evaledRedeemers = new Set<Core.Redeemer>();

  for (const evaluation of evaluations) {
    const purpose =
      ogmiosPurposeToTag[evaluation.validator?.purpose ?? ""] ?? 0;
    const index = BigInt(evaluation.validator?.index ?? 0);

    // Find matching redeemer
    const redeemer = currentRedeemers.find(
      (x: Core.Redeemer) => x.tag() === purpose && x.index() === index,
    );

    if (redeemer) {
      // Update execution units using setExUnits
      const exUnits = Core.ExUnits.fromCore({
        memory: evaluation.budget.memory,
        steps: evaluation.budget.cpu,
      });
      redeemer.setExUnits(exUnits);
      evaledRedeemers.add(redeemer);
    }
  }

  // Convert back to Redeemers
  return Core.Redeemers.fromCore(
    Array.from(evaledRedeemers).map((x: Core.Redeemer) => x.toCore()),
  );
};

export interface BrowserProviderOptions {
  /** Blockfrost API key */
  blockfrostApiKey: string;
  /** Network name (preview, preprod, mainnet, sanchonet) */
  network?: string;
}

/**
 * Creates a Blockfrost provider for browser use
 */
export async function createProvider(options?: BrowserProviderOptions) {
  // Support both environment variables and explicit options
  const BLOCKFROST_API_KEY =
    options?.blockfrostApiKey ||
    (typeof import.meta !== "undefined"
      ? (import.meta as { env?: Record<string, string | undefined> }).env
          ?.COSPONSOR_BLOCKFROST_API_KEY
      : undefined);
  const networkFromEnv =
    options?.network ||
    (typeof import.meta !== "undefined"
      ? (import.meta as { env?: Record<string, string | undefined> }).env
          ?.COSPONSOR_BLOCKFROST_NETWORK
      : undefined) ||
    "preprod";

  if (!BLOCKFROST_API_KEY) {
    throw new Error(
      "Blockfrost API key is required. Either pass it as an option or set COSPONSOR_BLOCKFROST_API_KEY environment variable.",
    );
  }

  // Map network names to Blockfrost format (cardano-*)
  const networkMap: Record<string, string> = {
    preview: "cardano-preview",
    preprod: "cardano-preprod",
    mainnet: "cardano-mainnet",
    sanchonet: "cardano-sanchonet",
  };

  const BLOCKFROST_NETWORK = (networkMap[networkFromEnv] || networkFromEnv) as
    | "cardano-preview"
    | "cardano-preprod"
    | "cardano-mainnet"
    | "cardano-sanchonet";

  logger.debug("Creating Blockfrost provider for network:", BLOCKFROST_NETWORK);

  return new Blockfrost({
    network: BLOCKFROST_NETWORK,
    projectId: BLOCKFROST_API_KEY,
  });
}

/**
 * Drop UTxOs whose payment credential is a script hash.
 *
 * A CIP-30 wallet can only witness payment-KEY inputs; a script-credential
 * UTxO offered as spendable can never be validly spent by coin selection
 * (no redeemer is attached for it). This is a real field failure mode:
 * Eternl exposed the cosponsor-script output of a just-submitted (pending)
 * deposit as a wallet UTxO, the next chained deposit coin-selected it, and
 * the on-chain mint validator rejected with `cosponsor_inputs == 0 ? False`
 * (2026-06-12). Filtering here protects every flow that builds from wallet
 * UTxOs.
 */
const dropScriptCredentialUtxos = (
  utxos: Core.TransactionUnspentOutput[],
): Core.TransactionUnspentOutput[] =>
  utxos.filter((utxo) => {
    const paymentPart = utxo.output().address().getProps().paymentPart;
    const isScript = paymentPart?.type === Core.CredentialType.ScriptHash;
    if (isScript) {
      logger.warn(
        `Wallet offered script-credential UTxO ` +
          `${utxo.input().transactionId()}#${utxo.input().index()} as ` +
          `spendable — dropping it from coin selection (unspendable ` +
          `without a redeemer)`,
      );
    }
    return !isScript;
  });

/**
 * Drop UTxOs already spent by a just-submitted (pending) transaction.
 *
 * Wallets refresh their exposed UTxO set lazily — in rapid tx chains
 * Eternl's getUtxos returned the same snapshot for every build (2026-06-12),
 * so the 3rd chained tx coin-selected an input the 1st had already spent and
 * the wallet rejected submission with "All inputs are spent". The UI records
 * every submitted tx's spent inputs in `pendingUtxoTracker`
 * (signAndSubmitTransaction) — consult it here so coin selection never
 * re-picks them.
 */
const dropPendingSpentUtxos = async (
  utxos: Core.TransactionUnspentOutput[],
): Promise<Core.TransactionUnspentOutput[]> => {
  const { pendingUtxoTracker } = await import("./utxoTracker.js");
  return utxos.filter((utxo) => {
    const txHash = utxo.input().transactionId();
    const index = Number(utxo.input().index());
    const spent = pendingUtxoTracker.isSpent(txHash, index);
    if (spent) {
      logger.debug(
        `Excluding wallet UTxO ${txHash.slice(0, 16)}...#${index} — already ` +
          `spent by a pending transaction`,
      );
    }
    return !spent;
  });
};

/** Combined wallet-UTxO hygiene: no script-credential, no pending-spent. */
const spendableWalletUtxos = async (
  utxos: Core.TransactionUnspentOutput[],
): Promise<Core.TransactionUnspentOutput[]> =>
  dropPendingSpentUtxos(dropScriptCredentialUtxos(utxos));

/**
 * Creates a CIP-30 wallet wrapper for use with Blaze
 * This wraps the browser wallet API (from wallet-lite) to work with Blaze
 */
export function createCIP30Wallet(
  walletApi: BrowserWalletApi,
  provider: Provider,
) {
  // Create a wallet implementation that Blaze can use
  // The wallet needs to provide methods that Blaze expects
  return {
    getNetworkId: async () => {
      const networkId = await walletApi.getNetworkId();
      return networkId;
    },
    getChangeAddress: async () => {
      const addressHex = await walletApi.getChangeAddress();
      return Core.Address.fromBytes(Core.HexBlob(addressHex));
    },
    getRewardAddresses: async () => {
      const rewardAddresses = await walletApi.getRewardAddresses();
      return rewardAddresses.map((addr: string) =>
        Core.Address.fromBytes(Core.HexBlob(addr)),
      );
    },
    getUsedAddresses: async () => {
      // CIP-30 doesn't have this, so return empty array
      return [];
    },
    getUnusedAddresses: async () => {
      // CIP-30 doesn't have this either, return change address
      const addressHex = await walletApi.getChangeAddress();
      return [Core.Address.fromBytes(Core.HexBlob(addressHex))];
    },
    getBalance: async () => {
      // Get total balance from UTxOs
      const utxosHex = await walletApi.getUtxos();
      if (!utxosHex || !utxosHex.length) {
        return 0n;
      }

      const utxos = await spendableWalletUtxos(
        utxosHex.map((utxoHex: string) =>
          Core.TransactionUnspentOutput.fromCbor(utxoHex as Core.HexBlob),
        ),
      );

      return utxos.reduce(
        (total: bigint, utxo: Core.TransactionUnspentOutput) =>
          total + utxo.output().amount().coin(),
        0n,
      );
    },
    getUnspentOutputs: async () => {
      const utxosHex = await walletApi.getUtxos();
      if (!utxosHex) {
        return [];
      }

      return spendableWalletUtxos(
        utxosHex.map((utxoHex: string) =>
          Core.TransactionUnspentOutput.fromCbor(utxoHex as Core.HexBlob),
        ),
      );
    },
    getCollateral: async () => {
      const collateralHex = await walletApi.getCollateral?.();
      if (!collateralHex || !collateralHex.length) {
        return [];
      }

      // Collateral must be key-credentialed (ledger rule) — same defensive
      // filter as getUnspentOutputs.
      return dropScriptCredentialUtxos(
        collateralHex.map((utxoHex: string) =>
          Core.TransactionUnspentOutput.fromCbor(utxoHex as Core.HexBlob),
        ),
      );
    },
    signTx: async (txHex: string, partialSign: boolean = false) => {
      const witnessSetHex = await walletApi.signTx(txHex, partialSign);
      return Core.TransactionWitnessSet.fromCbor(Core.HexBlob(witnessSetHex));
    },
    signTransaction: async (txHex: string, partialSign: boolean = false) => {
      // Alias for signTx
      const witnessSetHex = await walletApi.signTx(txHex, partialSign);
      return Core.TransactionWitnessSet.fromCbor(Core.HexBlob(witnessSetHex));
    },
    signData: async (address: string, payload: string) => {
      const signature = await walletApi.signData(address, payload);
      return signature;
    },
    postTransaction: async (tx: Core.Transaction | string) => {
      // Submit transaction through wallet
      const txHex = typeof tx === "string" ? tx : tx.toCbor();
      const txHash = await walletApi.submitTx(txHex);
      return txHash;
    },
    provider,
  };
}

/**
 * Minimal structural shape of a wallet observer this SDK consumes.
 * Matches @sundaeswap/wallet-lite's WalletObserver without coupling to it.
 */
export interface BrowserWalletObserver {
  api: BrowserWalletApi;
}

/**
 * Creates a Blaze instance using browser wallet with configured provider
 */
export async function createBlazeWithBrowserWallet(
  walletObserver: BrowserWalletObserver,
  options?: BrowserProviderOptions,
) {
  const provider = await createProvider(options);
  const wallet = createCIP30Wallet(walletObserver.api, provider);

  logger.debug("Creating Blaze instance with Blockfrost provider...");
  // @ts-expect-error - Wallet interface mismatch with Blaze SDK types
  const blaze = await Blaze.from(provider, wallet);

  logger.debug("Blaze instance created successfully");
  return blaze;
}
