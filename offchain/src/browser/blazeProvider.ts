
import {
  Blaze,
  Blockfrost,
  CIP30Interface,
  Core,
  Provider,
} from "@blaze-cardano/sdk";

import { logger } from "../logger.js";
// Ogmios purpose names to Blaze RedeemerTag mapping
const ogmiosPurposeToTag: Record<string, number> = {
  spend: 0,
  mint: 1,
  certificate: 2,
  withdraw: 3,
};

/**
 * Creates an Ogmios-based evaluator that has mempool access
 * This allows evaluating transactions that spend UTxOs from pending transactions
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
    _additionalUtxos: Core.TransactionUnspentOutput[],
  ): Promise<Core.Redeemers> => {
    const txCbor = tx.toCbor();

    logger.debug("🔍 Evaluating transaction with Ogmios (mempool-aware)...");

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(ogmiosUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Ogmios evaluation timeout"));
      }, 15000);

      ws.onopen = () => {
        const request = {
          jsonrpc: "2.0",
          method: "evaluateTransaction",
          params: { transaction: { cbor: txCbor } },
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

          // Parse Ogmios response and build Redeemers
          // Ogmios returns: [{ validator: { purpose, index }, budget: { memory, cpu } }]
          const evaluations = response.result;
          logger.debug("✅ Ogmios evaluation result:", evaluations);

          // Get existing redeemers from transaction (as array via values())
          const currentRedeemers = tx.witnessSet().redeemers()?.values();

          if (!currentRedeemers || currentRedeemers.length === 0) {
            reject(
              new Error(
                "evaluateTransaction: No Redeemers found in transaction",
              ),
            );
            return;
          }

          // Update each redeemer with execution units from Ogmios
          const evaledRedeemers = new Set<Core.Redeemer>();

          interface OgmiosEvaluation {
            validator?: { purpose?: string; index?: number };
            budget: { memory: number; cpu: number };
          }

          for (const evaluation of evaluations as OgmiosEvaluation[]) {
            const purpose = ogmiosPurposeToTag[evaluation.validator?.purpose ?? ""] ?? 0;
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
          resolve(
            Core.Redeemers.fromCore(
              Array.from(evaledRedeemers).map((x: Core.Redeemer) => x.toCore()),
            ),
          );
        } catch (e) {
          reject(e);
        }
      };

      ws.onerror = (err) => {
        clearTimeout(timeout);
        reject(new Error(`Ogmios WebSocket error: ${err}`));
      };
    });
  };
}

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
 * Creates a CIP-30 wallet wrapper for use with Blaze
 * This wraps the browser wallet API (from wallet-lite) to work with Blaze
 */
export function createCIP30Wallet(
  walletApi: CIP30Interface,
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

      const utxos = utxosHex.map((utxoHex: string) =>
        Core.TransactionUnspentOutput.fromCbor(utxoHex as Core.HexBlob),
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

      return utxosHex.map((utxoHex: string) => {
        const utxo = Core.TransactionUnspentOutput.fromCbor(
          utxoHex as Core.HexBlob,
        );
        return utxo;
      });
    },
    getCollateral: async () => {
      const collateralHex = await walletApi.getCollateral?.();
      if (!collateralHex || !collateralHex.length) {
        return [];
      }

      return collateralHex.map((utxoHex: string) => {
        const utxo = Core.TransactionUnspentOutput.fromCbor(
          utxoHex as Core.HexBlob,
        );
        return utxo;
      });
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
  api: CIP30Interface;
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
