import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

import { CardanoProvider } from "@utils/provider.js";
import { CosponsorState } from "@validators/CosponsorState.js";
import { Cosponsor } from "@validators/Cosponsor.js";
import { AlwaysTrue } from "@validators/AlwaysTrue.js";
import {
  PROPOSAL_LIFETIME,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
  SCRIPT_REFERENCE_ADDRESS,
  MIN_WALLET_BALANCE,
} from "@/Config.js";

import { createConfigurationTransaction } from "./configure.js";
import { deployContracts } from "./deploy.js";
import { registerRewardAccount } from "./register-reward-account.js";
import { mintStateNft } from "./mint-state-nft.js";
import { enableLocalUtxoChaining } from "@utils/utxoChaining.js";

dotenv.config();

/**
 * Phase-3 redeploy orchestrator.
 *
 * Runs the FULL fresh-deployment sequence hands-free, threading every output so
 * the operator never hand-copies a hash or tx id:
 *
 *   1. configure  — create a fresh 5-ADA boot UTxO (its tx id becomes the new
 *                   PROTOCOL_BOOT_TRANSACTION_ID). A fresh boot UTxO is required
 *                   because minting the state NFT SPENDS the boot UTxO, and the
 *                   previous deployment already consumed the old one.
 *   2. (recompute the parameterized CosponsorState + Cosponsor hashes from the
 *       NEW boot id — passed explicitly, never read from Config's frozen default)
 *   3. deploy     — deploy the 3 reference scripts to SCRIPT_REFERENCE_ADDRESS.
 *   4. register   — register the cosponsor script's reward account (needed for
 *                   the WPropose 0-lovelace withdrawal to be valid).
 *   5. mint       — mint the state NFT against the new boot UTxO.
 *   6. artifacts  — write deployed-contracts.json (via deploy), patch
 *                   BrowserConfig.ts in place, and emit redeploy-output.json.
 *
 * Resumable: pass `--from=<configure|deploy|register|mint>` to restart at a step
 * after a mid-sequence failure. State from completed steps (notably the new boot
 * id) is persisted to redeploy-state.json and reloaded on resume.
 *
 * SAFETY: this script SUBMITS on-chain transactions and spends ADA (fees + a
 * 5-ADA boot UTxO + a ~2-ADA stake-registration deposit + min-ADA for the state
 * NFT). Run only with a funded Preview wallet.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// src/scripts -> offchain -> repo root
const REPO_ROOT = path.join(__dirname, "../../..");
const BROWSER_CONFIG_PATH = path.join(__dirname, "../browser/BrowserConfig.ts");
const STATE_PATH = path.join(REPO_ROOT, "redeploy-state.json");
const OUTPUT_PATH = path.join(REPO_ROOT, "redeploy-output.json");

type Step = "configure" | "deploy" | "register" | "mint";
const STEP_ORDER: Step[] = ["configure", "deploy", "register", "mint"];

interface RedeployState {
  newBootId?: string;
  newBootIndex?: number;
  statePolicyId?: string;
  cosponsorHash?: string;
  cosponsorCbor?: string;
  alwaysTrueHash?: string;
  deploymentAddress?: string;
  deployTxIds?: {
    cosponsorState?: string;
    cosponsor?: string;
    alwaysTrue?: string;
  };
  registerTxId?: string | null;
  mintTxId?: string;
}

const loadState = (): RedeployState => {
  if (fs.existsSync(STATE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as RedeployState;
    } catch {
      return {};
    }
  }
  return {};
};

const saveState = (state: RedeployState): void => {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
};

const header = (title: string): void => {
  console.log(`\n${"=".repeat(70)}`);
  console.log(title);
  console.log("=".repeat(70));
};

/**
 * Recompute the parameterized hashes + cosponsor CBOR from an explicit boot id.
 * Never relies on Config.ts defaults.
 */
const recomputeArtifacts = (bootId: string, bootIndex: bigint) => {
  const cosponsorState = new CosponsorState(
    bootId,
    bootIndex,
    PROPOSAL_LIFETIME,
  );
  const statePolicyId = cosponsorState.script().hash();

  const cosponsor = Cosponsor.new({ statePolicyId });
  const cosponsorHash = cosponsor.script().hash();
  const cosponsorCbor = cosponsor.script().toCbor();

  const alwaysTrueHash = AlwaysTrue.script().hash();

  return { statePolicyId, cosponsorHash, cosponsorCbor, alwaysTrueHash };
};

/**
 * Replace a single value in the BrowserConfig source, asserting exactly one
 * substitution happened so a drifted file layout fails loudly instead of
 * silently leaving stale config.
 */
const patchOne = (
  src: string,
  regex: RegExp,
  replacement: string,
  label: string,
): string => {
  let count = 0;
  const out = src.replace(regex, (match, prefix) => {
    count++;
    return `${prefix}${replacement}`;
  });
  if (count !== 1) {
    throw new Error(
      `BrowserConfig patch for "${label}" matched ${count} times (expected 1). ` +
        `The file layout may have changed — patch manually and re-run with ` +
        `--from=<next-step>.`,
    );
  }
  return out;
};

/**
 * Patch BrowserConfig.ts in place with the freshly-deployed values.
 * Each regex captures everything up to (and including) the opening quote as
 * group 1, then swaps the quoted value.
 */
const patchBrowserConfig = (
  state: Required<
    Pick<
      RedeployState,
      | "statePolicyId"
      | "cosponsorHash"
      | "cosponsorCbor"
      | "alwaysTrueHash"
      | "deployTxIds"
    >
  >,
): void => {
  let src = fs.readFileSync(BROWSER_CONFIG_PATH, "utf8");

  const cosponsorTx = state.deployTxIds.cosponsor;
  const cosponsorStateTx = state.deployTxIds.cosponsorState;
  if (!cosponsorTx || !cosponsorStateTx) {
    throw new Error(
      "Missing deploy tx ids for BrowserConfig scriptReferenceUtxos patch.",
    );
  }

  // scriptReferenceUtxos.cosponsor.txHash
  src = patchOne(
    src,
    /(cosponsor:\s*\{\s*txHash:\s*)"[0-9a-fA-F]{64}"/,
    `"${cosponsorTx}"`,
    "scriptReferenceUtxos.cosponsor.txHash",
  );
  // scriptReferenceUtxos.cosponsorState.txHash
  src = patchOne(
    src,
    /(cosponsorState:\s*\{\s*txHash:\s*)"[0-9a-fA-F]{64}"/,
    `"${cosponsorStateTx}"`,
    "scriptReferenceUtxos.cosponsorState.txHash",
  );
  // top-level statePolicyId
  src = patchOne(
    src,
    /(statePolicyId:\s*)"[0-9a-fA-F]{56}"/,
    `"${state.statePolicyId}"`,
    "statePolicyId",
  );
  // scripts.cosponsorState.hash
  src = patchOne(
    src,
    /(cosponsorState:\s*\{\s*hash:\s*)"[0-9a-fA-F]{56}"/,
    `"${state.statePolicyId}"`,
    "scripts.cosponsorState.hash",
  );
  // scripts.cosponsor.hash
  src = patchOne(
    src,
    /(cosponsor:\s*\{\s*hash:\s*)"[0-9a-fA-F]{56}"/,
    `"${state.cosponsorHash}"`,
    "scripts.cosponsor.hash",
  );
  // scripts.cosponsor.cbor
  src = patchOne(
    src,
    /(cbor:\s*)"[0-9a-fA-F]+"/,
    `"${state.cosponsorCbor}"`,
    "scripts.cosponsor.cbor",
  );
  // scripts.alwaysTrue.hash (unparameterized; usually unchanged)
  src = patchOne(
    src,
    /(alwaysTrue:\s*\{\s*hash:\s*)"[0-9a-fA-F]{56}"/,
    `"${state.alwaysTrueHash}"`,
    "scripts.alwaysTrue.hash",
  );

  fs.writeFileSync(BROWSER_CONFIG_PATH, src);
  console.log(`✓ Patched ${BROWSER_CONFIG_PATH}`);
};

const writeOutput = (state: RedeployState): void => {
  const output = {
    timestamp: new Date().toISOString(),
    network: "cardano-preview",
    newBoot: {
      transactionId: state.newBootId,
      transactionIndex: state.newBootIndex,
    },
    hashes: {
      statePolicyId: state.statePolicyId,
      cosponsor: state.cosponsorHash,
      alwaysTrue: state.alwaysTrueHash,
    },
    cosponsorCbor: state.cosponsorCbor,
    deployment: {
      address: state.deploymentAddress,
      scriptReferenceAddress: SCRIPT_REFERENCE_ADDRESS,
      txIds: state.deployTxIds,
    },
    registerRewardAccountTxId: state.registerTxId ?? null,
    mintStateNftTxId: state.mintTxId,
    // Exact values the operator should set (env or Config.ts defaults).
    envToSet: {
      PROTOCOL_BOOT_TRANSACTION_ID: state.newBootId,
      PROTOCOL_BOOT_TRANSACTION_INDEX: String(state.newBootIndex ?? 0),
      PROPOSAL_LIFETIME_MS: String(PROPOSAL_LIFETIME),
      SCRIPT_REFERENCE_ADDRESS: SCRIPT_REFERENCE_ADDRESS,
    },
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`✓ Wrote ${OUTPUT_PATH}`);
};

const awaitConfirm = async (
  cardanoProvider: CardanoProvider,
  txId: string,
  label: string,
): Promise<void> => {
  console.log(`Waiting for ${label} confirmation (${txId})...`);
  await cardanoProvider.getBlaze().provider.awaitTransactionConfirmation(txId);
  // Refresh wallet UTxOs so the next step sees settled state.
  await cardanoProvider.getWallet().getUnspentOutputs();
  console.log(`✓ ${label} confirmed`);
};

const parseFrom = (): Step => {
  const arg = process.argv.find((a) => a.startsWith("--from="))?.split("=")[1];
  if (!arg) return "configure";
  if ((STEP_ORDER as string[]).includes(arg)) return arg as Step;
  throw new Error(
    `Invalid --from="${arg}". Expected one of: ${STEP_ORDER.join(", ")}`,
  );
};

const shouldRun = (from: Step, step: Step): boolean =>
  STEP_ORDER.indexOf(step) >= STEP_ORDER.indexOf(from);

export const redeploy = async (
  cardanoProvider: CardanoProvider,
  from: Step = "configure",
): Promise<RedeployState> => {
  const state = loadState();

  // ---- Step 1: configure ----
  if (shouldRun(from, "configure")) {
    header("STEP 1/5 — CONFIGURE (create fresh boot UTxO)");
    const bootId = await createConfigurationTransaction(cardanoProvider);
    state.newBootId = bootId;
    // configure.ts pays the boot output first (index 0), change after — this
    // matches the Config default index. Documented assumption.
    state.newBootIndex = Number(PROTOCOL_BOOT_TRANSACTION_INDEX);
    saveState(state);
    await awaitConfirm(cardanoProvider, bootId, "boot UTxO");
  }

  if (!state.newBootId) {
    throw new Error(
      `No boot id available. Run without --from (or --from=configure) first.`,
    );
  }
  const bootId = state.newBootId;
  const bootIndex = BigInt(state.newBootIndex ?? 0);

  // ---- Step 2: recompute parameterized artifacts from the NEW boot id ----
  header("Recomputing parameterized hashes from new boot id");
  const { statePolicyId, cosponsorHash, cosponsorCbor, alwaysTrueHash } =
    recomputeArtifacts(bootId, bootIndex);
  state.statePolicyId = statePolicyId;
  state.cosponsorHash = cosponsorHash;
  state.cosponsorCbor = cosponsorCbor;
  state.alwaysTrueHash = alwaysTrueHash;
  saveState(state);
  console.log(`  Boot UTxO:        ${bootId}:${bootIndex}`);
  console.log(`  CosponsorState:   ${statePolicyId}`);
  console.log(`  Cosponsor:        ${cosponsorHash}`);
  console.log(`  AlwaysTrue:       ${alwaysTrueHash}`);

  // ---- Step 3: deploy reference scripts ----
  if (shouldRun(from, "deploy")) {
    header("STEP 2/5 — DEPLOY reference scripts");
    // Deploy to SCRIPT_REFERENCE_ADDRESS so mint-state-nft can resolve the refs.
    const deployed = await deployContracts(
      cardanoProvider,
      SCRIPT_REFERENCE_ADDRESS,
      bootId,
      bootIndex,
      PROPOSAL_LIFETIME,
    );
    state.deploymentAddress = SCRIPT_REFERENCE_ADDRESS;
    state.deployTxIds = {
      cosponsorState: deployed.get("CosponsorState"),
      cosponsor: deployed.get("Cosponsor (Parameterized)"),
      alwaysTrue: deployed.get("AlwaysTrue"),
    };
    saveState(state);

    // Ensure the state + cosponsor reference deploys are confirmed before mint.
    if (state.deployTxIds.cosponsorState) {
      await awaitConfirm(
        cardanoProvider,
        state.deployTxIds.cosponsorState,
        "CosponsorState deploy",
      );
    }
  }

  // ---- Step 4: register reward account ----
  if (shouldRun(from, "register")) {
    header("STEP 3/5 — REGISTER cosponsor reward account");
    const registerTxId = await registerRewardAccount(
      cardanoProvider,
      cosponsorHash,
    );
    state.registerTxId = registerTxId;
    saveState(state);
    if (registerTxId) {
      await awaitConfirm(
        cardanoProvider,
        registerTxId,
        "reward-account register",
      );
    }
  }

  // ---- Step 5: mint state NFT ----
  if (shouldRun(from, "mint")) {
    header("STEP 4/5 — MINT state NFT");
    const mintTxId = await mintStateNft(
      cardanoProvider,
      bootId,
      bootIndex,
      PROPOSAL_LIFETIME,
    );
    state.mintTxId = mintTxId;
    saveState(state);
    await awaitConfirm(cardanoProvider, mintTxId, "state NFT mint");
  }

  // ---- Step 6: write artifacts ----
  header("STEP 5/5 — WRITE artifacts (BrowserConfig + redeploy-output.json)");
  patchBrowserConfig({
    statePolicyId: state.statePolicyId!,
    cosponsorHash: state.cosponsorHash!,
    cosponsorCbor: state.cosponsorCbor!,
    alwaysTrueHash: state.alwaysTrueHash!,
    deployTxIds: state.deployTxIds!,
  });
  writeOutput(state);

  return state;
};

const main = async () => {
  console.log("CoSponsor Phase-3 Redeploy");
  console.log("==========================");

  const from = parseFrom();
  console.log(`Starting from step: ${from}`);

  let cardanoProvider: CardanoProvider | null = null;
  let currentStep: Step = from;

  try {
    cardanoProvider = await CardanoProvider.fromEnv();

    // Chain the deploy/register/mint txs off a locally-maintained UTxO set
    // instead of trusting the provider to reflect each spend before the next
    // build — Blockfrost's address index lags a beat and makes the running
    // change output get reselected (see utxoChaining.ts). Harmless on Kupmios.
    const walletBech32 = (await cardanoProvider.getWalletAddress()).toBech32();
    enableLocalUtxoChaining(cardanoProvider.getBlaze(), walletBech32);

    const balance = await cardanoProvider.getWalletBalance();
    console.log(`Wallet balance: ${balance.balance / 1_000_000n} ADA`);
    if (balance.balance < MIN_WALLET_BALANCE) {
      throw new Error(
        `Insufficient balance. Need at least ${MIN_WALLET_BALANCE / 1_000_000n} ADA, have ${balance.balance / 1_000_000n} ADA`,
      );
    }

    // Track which step is executing for a helpful resume hint on failure.
    for (const step of STEP_ORDER) {
      if (shouldRun(from, step)) {
        currentStep = step;
        break;
      }
    }

    const finalState = await redeploy(cardanoProvider, from);

    header("REDEPLOY COMPLETE");
    console.log("New boot id:      ", finalState.newBootId);
    console.log("CosponsorState:   ", finalState.statePolicyId);
    console.log("Cosponsor:        ", finalState.cosponsorHash);
    console.log("Deploy tx ids:    ", JSON.stringify(finalState.deployTxIds));
    console.log(
      "Register tx id:   ",
      finalState.registerTxId ?? "(already registered)",
    );
    console.log("Mint tx id:       ", finalState.mintTxId);
    console.log("");
    console.log(`Full summary written to: ${OUTPUT_PATH}`);
    console.log(
      `Set PROTOCOL_BOOT_TRANSACTION_ID=${finalState.newBootId} in your .env`,
    );
    console.log("=".repeat(70));
  } catch (error) {
    console.error(`\n✗ Redeploy failed during/after step: ${currentStep}`);
    console.error(error);
    console.error(
      `\nTo resume once the cause is fixed, re-run:\n` +
        `  bun run redeploy --from=${currentStep}\n` +
        `(completed-step outputs — including the new boot id — are cached in ${STATE_PATH})`,
    );
    process.exit(1);
  } finally {
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
};

// Run main if this script is executed directly
if (
  process.argv[1] &&
  import.meta.url.includes(process.argv[1].replace(/\\/g, "/"))
) {
  main().catch(console.error);
}

export default redeploy;
