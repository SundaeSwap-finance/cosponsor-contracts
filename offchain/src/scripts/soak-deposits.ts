/**
 * Deposit soak harness — exercises the deposit/withdraw path end-to-end with a
 * headless HotWallet, firing many chained deposits (each forced to chain onto
 * the previous unconfirmed change) and then withdrawing them all. Originally
 * built to reproduce the intermittent `cosponsor_inputs != 0` mint failure.
 *
 * Mirrors the UI deposit path: browserDeposit → the SDK chained evaluator
 * (`wrapEvaluatorWithWalletUtxos`, with the deposit guard) → complete() → sign →
 * submit via the Ogmios node mempool (accepts chained txs, like Eternl;
 * Blockfrost's submit endpoint rejects them) → record effects in
 * `pendingUtxoTracker`. The deposit guard is the SDK's — a deposit that ends up
 * spending a Cosponsor script UTxO throws here instead of failing on-chain.
 *
 * Collateral: a HotWallet has no reserved collateral (the browser gets it from
 * Eternl's CIP-30 getCollateral). We reserve ONE fixed pure-ADA UTxO, pin
 * getCollateral() to it, and exclude it from funding selection. Run `setup` once.
 *
 * Env: WALLET_SEED_PHRASE, BLOCKFROST_API_KEY, OGMIOS_URL.
 * Usage:
 *   bun src/scripts/soak-deposits.ts setup            # create collateral UTxO
 *   bun src/scripts/soak-deposits.ts [perType] [ada] [delayMs]   # deposits, N per proposal type
 *   bun src/scripts/soak-deposits.ts withdraw         # reclaim everything
 */

import {
  Blaze,
  Blockfrost,
  HotWallet,
  Core,
  type Provider,
  type Wallet,
} from "@blaze-cardano/sdk";
import { Bip32PrivateKey } from "@blaze-cardano/core";
import { mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Unwrapped } from "@blaze-cardano/ogmios";
import {
  browserDeposit,
  browserWithdraw,
  fetchWithdrawalPlan,
  createOgmiosEvaluator,
  pendingUtxoTracker,
  extractTransactionEffects,
  BROWSER_CONFIG,
} from "@/browser/index.js";
import { wrapEvaluatorWithWalletUtxos } from "@/browser/chainedTxEvaluator.js";
import type { ICosponsoredProposal } from "@/validators/index.js";
import type { TGovernanceAction } from "@/validators/Types/GovernanceAction.js";

const NETWORK = "cardano-preview" as const;
const OGMIOS_URL = process.env.OGMIOS_URL;
const GOV_ACTION_DEPOSIT = 100_000_000_000n;
const COLLATERAL_LOVELACE = 5_135_630n; // exactly 5.13563 ADA — reserved, never funded from
const COSPONSOR_HASH = BROWSER_CONFIG.scripts.cosponsor.hash;

type TOgmios = Awaited<ReturnType<typeof Unwrapped.Ogmios.new>>;
type TUtxo = Core.TransactionUnspentOutput;

// One proposal per governance-action type, each with a distinct (hex) anchor so
// it mints a distinct gADA token. Mirrors the shapes the UI's
// buildGovernanceAction produces.
const mkProposal = (
  tagHex: string,
  action: TGovernanceAction,
): ICosponsoredProposal => ({
  deposit: GOV_ACTION_DEPOSIT,
  anchor: {
    url: Buffer.from(`https://cosponsor.app/proposal/${tagHex}`).toString(
      "hex",
    ),
    hash: tagHex.padEnd(64, "0").slice(0, 64),
  },
  action,
});

const PROPOSAL_TYPES: { name: string; proposal: ICosponsoredProposal }[] = [
  {
    name: "ProtocolParameters",
    proposal: mkProposal("deadbeef01", {
      kind: "ProtocolParameters",
      ancestor: null,
    } as TGovernanceAction),
  },
  {
    name: "HardFork",
    proposal: mkProposal("deadbeef02", {
      kind: "HardFork",
      ancestor: null,
      version: { major: 10, minor: 0 },
    } as TGovernanceAction),
  },
  {
    name: "TreasuryWithdrawal",
    proposal: mkProposal("deadbeef03", {
      kind: "TreasuryWithdrawal",
      beneficiaries: new Map([[{ vkey: "ab".repeat(28) }, 1_000_000n]]),
      guardRails: undefined,
    } as unknown as TGovernanceAction),
  },
  {
    name: "NoConfidence",
    proposal: mkProposal("deadbeef04", {
      kind: "NoConfidence",
      ancestor: null,
    } as TGovernanceAction),
  },
  {
    name: "ConstitutionalCommittee",
    proposal: mkProposal("deadbeef05", {
      kind: "ConstitutionalCommittee",
      ancestor: null,
      membersToRemove: [],
      membersToAdd: new Map(),
      quorum: { numerator: 2n, denominator: 3n },
    } as unknown as TGovernanceAction),
  },
  {
    name: "NewConstitution",
    proposal: mkProposal("deadbeef06", {
      kind: "NewConstitution",
      ancestor: null,
    } as TGovernanceAction),
  },
  {
    name: "NicePoll",
    proposal: mkProposal("deadbeef07", {
      kind: "NicePoll",
    } as TGovernanceAction),
  },
];

const utxoId = (u: TUtxo) =>
  `${u.input().transactionId()}#${u.input().index()}`;
const isScriptCred = (u: TUtxo) =>
  u.output().address().getProps().paymentPart?.type ===
  Core.CredentialType.ScriptHash;
const dropScriptCred = (utxos: TUtxo[]) =>
  utxos.filter((u) => !isScriptCred(u));
const isPureAda = (u: TUtxo) =>
  (u.output().amount().multiasset()?.size ?? 0) === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHUNK_LOVELACE = 150_000_000n; // ~150 ADA per withdrawal tx to stay under tx-size limits

const bootstrap = async () => {
  const seed = process.env.WALLET_SEED_PHRASE;
  const projectId = process.env.BLOCKFROST_API_KEY;
  if (!seed) throw new Error("WALLET_SEED_PHRASE is required");
  if (!projectId) throw new Error("BLOCKFROST_API_KEY is required");

  const provider = new Blockfrost({ network: NETWORK, projectId });
  const entropy = mnemonicToEntropy(seed.trim(), wordlist);
  const rootKey = Bip32PrivateKey.fromBip39Entropy(Buffer.from(entropy), "");
  const wallet = await HotWallet.fromMasterkey(rootKey.hex(), provider);
  const blaze = await Blaze.from(provider as Provider, wallet);
  return blaze as unknown as Blaze<Provider, Wallet>;
};

const findCollateral = async (
  blaze: Blaze<Provider, Wallet>,
): Promise<TUtxo | null> => {
  const addr = await blaze.wallet.getChangeAddress();
  const utxos = await blaze.provider.getUnspentOutputs(addr);
  return (
    utxos.find(
      (u) => u.output().amount().coin() === COLLATERAL_LOVELACE && isPureAda(u),
    ) ?? null
  );
};

// Unconfirmed wallet change we track ourselves — the SDK tracker only tracks
// script outputs (in the browser, Eternl supplies the change from its mempool
// view; a headless HotWallet has none, so we reconstruct it here).
const pendingChange = new Map<string, TUtxo>();

const recordChange = (txId: string, completed: Core.Transaction) => {
  const outs = completed.body().outputs();
  for (let i = 0; i < outs.length; i++) {
    const o = outs[i];
    if (o.datum()) continue; // script output (deposit) — not spendable as plain change
    const input = new Core.TransactionInput(
      Core.TransactionId(txId),
      BigInt(i),
    );
    pendingChange.set(
      `${txId}#${i}`,
      new Core.TransactionUnspentOutput(input, o),
    );
  }
};

// Reserve `collateral` and keep it out of funding selection; make funding
// pending-aware (tracker spent-set + our change) + drop scripts.
const installWalletPatches = (
  blaze: Blaze<Provider, Wallet>,
  collateral: TUtxo,
) => {
  const wallet = blaze.wallet;
  const collId = utxoId(collateral);
  const origGetUnspent = wallet.getUnspentOutputs.bind(wallet);
  wallet.getUnspentOutputs = async () => {
    const byId = new Map<string, TUtxo>();
    for (const u of pendingUtxoTracker.applyToUtxoList(await origGetUnspent()))
      byId.set(utxoId(u), u);
    for (const [id, u] of pendingChange) {
      if (
        !pendingUtxoTracker.isSpent(
          u.input().transactionId(),
          Number(u.input().index()),
        )
      )
        byId.set(id, u);
    }
    return dropScriptCred([...byId.values()]).filter(
      (u) => utxoId(u) !== collId,
    );
  };
  wallet.getCollateral = async () => [collateral];
};

// Collateral hygiene only (no pending tracker / change injection): withdrawals
// run one-at-a-time waiting for confirmation, so the wallet reads fresh state.
const installCollateralOnly = (
  blaze: Blaze<Provider, Wallet>,
  collateral: TUtxo,
) => {
  const wallet = blaze.wallet;
  const collId = utxoId(collateral);
  const origGetUnspent = wallet.getUnspentOutputs.bind(wallet);
  wallet.getUnspentOutputs = async () =>
    (await origGetUnspent()).filter((u) => utxoId(u) !== collId);
  wallet.getCollateral = async () => [collateral];
};

const setupCollateral = async (blaze: Blaze<Provider, Wallet>) => {
  const existing = await findCollateral(blaze);
  if (existing) {
    console.log(
      `Collateral UTxO already exists: ${utxoId(existing)} (5.13563 ADA)`,
    );
    return;
  }
  const addr = await blaze.wallet.getChangeAddress();
  const tx = await blaze
    .newTransaction()
    .payLovelace(addr, COLLATERAL_LOVELACE)
    .complete();
  const signed = await blaze.signTransaction(tx);
  const txId = String(await blaze.provider.postTransactionToChain(signed));
  console.log(`Created collateral UTxO (5.13563 ADA) in tx ${txId}`);
  console.log("Wait for confirmation, then run the soak.");
};

const submitDeposit = async (
  blaze: Blaze<Provider, Wallet>,
  ogmios: TOgmios,
  collateral: TUtxo,
  proposal: ICosponsoredProposal,
  depositAmount: bigint,
  label: string,
) => {
  let tx = await browserDeposit({
    blaze,
    cosponsoredProposal: proposal,
    depositAmount,
  });
  if (OGMIOS_URL) {
    // Deposit guard ON: refuse a tx that spends a Cosponsor script UTxO.
    tx = tx.useEvaluator(
      wrapEvaluatorWithWalletUtxos(blaze, createOgmiosEvaluator(OGMIOS_URL), {
        rejectCosponsorInputHash: COSPONSOR_HASH,
      }),
    );
  }
  tx.provideCollateral([collateral]);
  const completed = await tx.complete();
  const signed = await blaze.signTransaction(completed);
  const txId = String(
    (await ogmios.submitTransaction({ cbor: signed.toCbor() })).transaction.id,
  );

  const { spentInputs, createdOutputs } = extractTransactionEffects(
    completed,
    txId,
  );
  pendingUtxoTracker.recordTransaction(txId, spentInputs, createdOutputs);
  recordChange(txId, completed);
  console.log(`  ✓ ${label} submitted: ${txId}`);
  return txId;
};

const withdrawAll = async (
  blaze: Blaze<Provider, Wallet>,
  ogmios: TOgmios,
  collateral: TUtxo,
) => {
  installCollateralOnly(blaze, collateral);
  for (let round = 1; ; round++) {
    const plan = await fetchWithdrawalPlan(blaze);
    const available = plan.availableToWithdraw;
    console.log(
      `round ${round}: ${Number(available) / 1e6} ADA available to withdraw`,
    );
    if (available < 2_000_000n) {
      console.log("Nothing left to withdraw.");
      break;
    }
    const amount = available < CHUNK_LOVELACE ? available : CHUNK_LOVELACE;
    // No guard on withdrawals — they legitimately spend Cosponsor script UTxOs.
    let tx = await browserWithdraw({
      blaze,
      withdrawalPlan: plan,
      withdrawAmount: amount,
    });
    if (OGMIOS_URL) {
      tx = tx.useEvaluator(
        wrapEvaluatorWithWalletUtxos(blaze, createOgmiosEvaluator(OGMIOS_URL)),
      );
    }
    tx.provideCollateral([collateral]);
    const completed = await tx.complete();
    const signed = await blaze.signTransaction(completed);
    const txId = String(
      (await ogmios.submitTransaction({ cbor: signed.toCbor() })).transaction
        .id,
    );
    console.log(
      `  ✓ withdrew ${Number(amount) / 1e6} ADA in ${txId}; waiting for confirmation…`,
    );

    let confirmed = false;
    for (let i = 0; i < 20; i++) {
      await sleep(15000);
      if ((await fetchWithdrawalPlan(blaze)).availableToWithdraw < available) {
        confirmed = true;
        break;
      }
    }
    if (!confirmed)
      throw new Error(`withdrawal ${txId} did not confirm in time`);
  }
};

const main = async () => {
  if (!OGMIOS_URL)
    throw new Error("OGMIOS_URL is required (submission + evaluation)");
  const blaze = await bootstrap();
  console.log("wallet:", (await blaze.wallet.getChangeAddress()).toBech32());

  if (process.argv[2] === "setup") {
    await setupCollateral(blaze);
    return;
  }

  const collateral = await findCollateral(blaze);
  if (!collateral)
    throw new Error(
      "No 5.13563 ADA collateral UTxO found — run `setup` first.",
    );

  if (process.argv[2] === "withdraw") {
    const ogmios = await Unwrapped.Ogmios.new(OGMIOS_URL);
    try {
      await withdrawAll(blaze, ogmios, collateral);
      console.log("Done.");
    } finally {
      await ogmios.shutdown?.();
    }
    return;
  }

  // Deposit mode: `perType` deposits for each of the 7 governance-action types.
  const perType = Number(process.argv[2] ?? "5");
  const depositAda = Number(process.argv[3] ?? "10");
  const delayMs = Number(process.argv[4] ?? "2000");
  const depositAmount = BigInt(Math.floor(depositAda * 1_000_000));

  installWalletPatches(blaze, collateral);
  console.log(`collateral: ${utxoId(collateral)} (reserved)`);
  console.log(
    `Soak: ${perType} deposit(s) × ${PROPOSAL_TYPES.length} proposal types of ${depositAda} ADA each, delay=${delayMs}ms`,
  );

  const ogmios = await Unwrapped.Ogmios.new(OGMIOS_URL);
  try {
    for (const { name, proposal } of PROPOSAL_TYPES) {
      for (let i = 1; i <= perType; i++) {
        await submitDeposit(
          blaze,
          ogmios,
          collateral,
          proposal,
          depositAmount,
          `${name} ${i}/${perType}`,
        );
        await sleep(delayMs);
      }
    }
    console.log("Done.");
  } finally {
    await ogmios.shutdown?.();
  }
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("soak failed:", err);
    process.exit(1);
  });
