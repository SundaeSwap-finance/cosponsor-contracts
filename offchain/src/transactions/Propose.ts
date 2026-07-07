/**
 * Propose transaction builder (Phase 2 of AUDIT-PROPOSE-PATH.md).
 *
 * Spends the pooled `Before` deposits for ONE proposal and submits the
 * pledged governance action on-chain. Blaze has no governance support, so
 * the strategy is:
 *
 *   1. build everything Blaze CAN express (spends, state update, 0-lovelace
 *      WPropose withdrawal, AlwaysTrue marker mint, ttl, collateral) and
 *      `complete()` it with a STUB evaluator (real evaluation MUST fail
 *      pre-splice: the body lacks `proposal_procedures` so the validator's
 *      body-hash check cannot pass yet);
 *   2. converge the collateral-bytes / script_data_hash feedback loop —
 *      the WPropose redeemer must carry the RAW bytes of body fields
 *      13/16/17 (invisible to the script context) and the AlwaysTrue token
 *      name must equal the FINAL script_data_hash;
 *   3. splice body field 20 (`proposal_procedures`) via the canonical
 *      encoders in utils/proposeBody.ts, which recomputes the transaction
 *      id implicitly (the id IS the blake2b-256 of the spliced body).
 *
 * ── SIGNING CONTRACT ────────────────────────────────────────────────────
 * The returned `Core.Transaction` must be signed over its EXACT CBOR
 * (`tx.toCbor()` → CIP-30 `signTx(cbor, true)` / HotWallet signing of the
 * same bytes). The on-chain validator requires
 * `transaction.id == blake2b_256(body_bytes)` for THIS body layout — any
 * wallet or tool that deserializes and re-serializes the transaction
 * (re-ordering map keys, changing set tags, "canonicalizing" ints) will
 * produce a different body, a different id, and a guaranteed on-chain
 * rejection. Submit the signed witness together with the original CBOR;
 * never round-trip the body through another serializer.
 * ────────────────────────────────────────────────────────────────────────
 */

import { Blaze, Core, makeValue, Provider, Wallet } from "@blaze-cardano/sdk";
import { Address, HexBlob } from "@blaze-cardano/core";
import { parse, serialize } from "@blaze-cardano/data";
import {
  PROPOSAL_LIFETIME,
  PROTOCOL_BOOT_TRANSACTION_ID,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
  SCRIPT_REFERENCE_ADDRESS,
} from "@/Config.js";
import { Cosponsor, ICosponsoredProposal } from "@validators/Cosponsor.js";
import { CosponsorState } from "@validators/CosponsorState.js";
import { AlwaysTrue } from "@validators/AlwaysTrue.js";
import { CosponsorTypes } from "@validators/GeneratedTypes/index.js";
import {
  cborUint,
  encodeProposalProcedures,
  spliceProposalProcedures,
  transactionIdFromBody,
} from "@/utils/proposeBody.js";
import {
  anchorUrlHexToText,
  canonicalizeBodyInputSets,
  canonicalizeTransactionInputSets,
  cborByteString,
  computeLeftover,
  extractCollateralFieldHex,
  extractScriptDataHash,
  listBodyKeys,
  mpfRootAfterFirstInsert,
  NULL_MPF_ROOT,
  runFixedPoint,
  type ICollateralFieldHex,
} from "@/utils/proposeBuilder.js";
import { scriptAddressFromHash } from "@/utils/scriptAddress.js";
import {
  blockfrostStateChainQueries,
  buildStateMpfInsertion,
  reconstructStateLeaves,
  type IStateChainQueries,
} from "@/utils/mpfReconstruct.js";
import {
  actionNeedsGuardrails,
  appendProposingRedeemer,
  GUARDRAILS_FEE_PAD,
  resolveGuardrailsReference,
  usedCostModelsV3,
} from "@/utils/guardrails.js";
import { extractInlineDatum } from "@helpers/datumUtils.js";
import { logger } from "../logger.js";

/** Default validity window: now + 2 hours (body ttl, field 3, is REQUIRED). */
const DEFAULT_VALIDITY_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Fee freeze pad. After pass 1 the fee is pinned via `setMinimumFee`
 * (Blaze applies `max(computed, minimum)`), so later passes — whose
 * redeemers carry the real, slightly larger collateral bytes — still land
 * on the exact same fee and the collateral fields stop drifting.
 */
const FEE_FREEZE_PAD = 200_000n;

/**
 * Total execution-unit budget the stub evaluator distributes across all
 * redeemers, kept under the per-transaction caps (14M mem / 10G steps on
 * preview) with headroom. Generous on purpose: the returned exUnits are
 * NEVER corrected with a real evaluation (the redeemers must not change
 * after the fixed point), so the fee simply pays for the padding.
 */
const STUB_TOTAL_MEM = 12_000_000n;
const STUB_TOTAL_STEPS = 9_000_000_000n;

const NFT_ASSET_NAME_HEX = Buffer.from("cosponsor_state_nft").toString("hex");

/**
 * Build the Blockfrost-backed chain queries used to reconstruct a non-empty
 * state MPF trie, from `BLOCKFROST_API_KEY` + the provider network. Throws a
 * clear error if the key is absent (e.g. browser / Kupmios callers, who must
 * pass `stateChainQueries` in the propose args instead).
 */
const defaultStateChainQueries = (
  networkId: Core.NetworkId,
): IStateChainQueries => {
  const env = typeof process !== "undefined" ? process.env : undefined;
  const projectId = env?.BLOCKFROST_API_KEY;
  if (!projectId) {
    throw new Error(
      "propose: this deployment's state MPF trie is non-empty, so building " +
        "the proposal requires chain-index queries to reconstruct it. Set " +
        "BLOCKFROST_API_KEY, or pass `stateChainQueries` in the propose args.",
    );
  }
  // NetworkId only distinguishes mainnet (1) from testnet (0); preview vs
  // preprod is not recoverable from it, so allow an explicit override and
  // default testnet to preview (this project's network).
  const network =
    env?.BLOCKFROST_NETWORK ||
    (Number(networkId) === 1 ? "cardano-mainnet" : "cardano-preview");
  return blockfrostStateChainQueries(projectId, network);
};

/**
 * Replace the (empty) `proof` field of a serialized CosponsorStateRedeemer with
 * the real MPF proof PlutusData. The redeemer is `Constr 0 [proof, anchorList]`;
 * we swap field 0 and keep the SDK-encoded anchorList (field 1) untouched.
 */
const spliceStateProof = (
  base: Core.PlutusData,
  proofCborHex: string,
): Core.PlutusData => {
  const constr = base.asConstrPlutusData();
  if (!constr) {
    throw new Error("propose: state redeemer is not a Constr (cannot splice)");
  }
  const fields = constr.getData();
  const newFields = new Core.PlutusList();
  newFields.add(Core.PlutusData.fromCbor(HexBlob(proofCborHex)));
  newFields.add(fields.get(1));
  return Core.PlutusData.newConstrPlutusData(
    new Core.ConstrPlutusData(constr.getAlternative(), newFields),
  );
};

export interface IProposeArgs<P extends Provider, W extends Wallet> {
  blaze: Blaze<P, W>;
  /** The proposal whose pooled deposits fund the on-chain submission. */
  cosponsoredProposal: ICosponsoredProposal;
  /** Enable debug logging. */
  debugMode?: boolean;
  /**
   * Optional override for the validity upper bound (unix ms). The proposal
   * expiration recorded in the state trie is
   * `slot_begin_ms(ttl) + PROPOSAL_LIFETIME`.
   */
  validUntilUnixMs?: number;
  /**
   * Chain-index queries used to reconstruct a NON-empty state MPF trie (needed
   * whenever this deployment already holds >= 1 submitted proposal). Optional:
   * when omitted, a Blockfrost-backed implementation is built from
   * `BLOCKFROST_API_KEY` + the provider network. Browser/non-Blockfrost callers
   * must pass this explicitly (see `mpfReconstruct.ts`). Unused when the trie is
   * still empty (first propose after deploy).
   */
  stateChainQueries?: IStateChainQueries;
}

/**
 * Pre-resolved script context, so the browser wrapper can supply
 * BROWSER_CONFIG-driven hashes/references without instantiating the
 * parameterized validator classes (browsers cannot apply script
 * parameters at runtime — see BrowserConfig.ts).
 */
export interface IProposeScriptContext {
  /** Cosponsor validator hash (payment credential of the pool address). */
  cosponsorHash: string;
  /** CosponsorState validator hash (also the state NFT policy id). */
  statePolicyId: string;
  /** AlwaysTrue policy id (marker token minted with the script data hash). */
  alwaysTruePolicyId: string;
  /** gADA asset name: blake2b-256 of the serialized proposal procedure. */
  proposalHash: string;
  /** `Before { cosponsored }` datum for the leftover output. */
  beforeDatum: Core.PlutusData;
  /** Reference UTxO carrying the cosponsor script. */
  cosponsorReference: Core.TransactionUnspentOutput;
  /** Reference UTxO carrying the cosponsor_state script. */
  stateReference: Core.TransactionUnspentOutput;
  /** Reference UTxO carrying the AlwaysTrue script, if deployed. */
  alwaysTrueReference?: Core.TransactionUnspentOutput;
  /** Fallback witness script when no AlwaysTrue reference exists. */
  alwaysTrueScript?: Core.Script;
  /**
   * Reference UTxO carrying the constitution guardrails script. REQUIRED for
   * TreasuryWithdrawal / ProtocolParameters actions (the ledger runs the
   * guardrails as a proposing-purpose script); ignored otherwise. See
   * utils/guardrails.ts.
   */
  guardrailsReference?: Core.TransactionUnspentOutput;
}

interface IFixedPointState extends ICollateralFieldHex {
  /** script_data_hash candidate — doubles as the mint token name. */
  sdh: string;
}

/** Fresh void redeemer (Constr 0 []) — the cosponsor spend validator and the
 * AlwaysTrue mint ignore their redeemers, but an entry must exist.
 *
 * DEVIATION: the task sheet suggested
 * `serialize(CosponsorTypes.CosponsorRedeemer, "SPropose")`, but no such
 * type exists in the generated types (the spend redeemer is `Data` on
 * chain), so a unit constructor is used instead. */
const voidRedeemer = (): Core.PlutusData =>
  Core.PlutusData.newConstrPlutusData(
    new Core.ConstrPlutusData(0n, new Core.PlutusList()),
  );

/** Body keys the canonical reconstruction accepts (before splicing 20). */
const ALLOWED_BODY_KEYS = new Set([0, 1, 2, 3, 5, 9, 11, 13, 14, 16, 17, 18]);
const REQUIRED_BODY_KEYS = [0, 1, 2, 3, 5, 9, 11, 13, 16, 17, 18];

/**
 * Core implementation. See the module JSDoc for the overall strategy and
 * the signing contract. Returns a COMPLETED transaction with body field 20
 * spliced in — NOT a TxBuilder — because the post-processing happens after
 * `complete()`.
 */
export const proposeWithScriptContext = async <
  P extends Provider,
  W extends Wallet,
>(
  {
    blaze,
    cosponsoredProposal,
    debugMode = false,
    validUntilUnixMs,
    stateChainQueries,
  }: IProposeArgs<P, W>,
  ctx: IProposeScriptContext,
): Promise<Core.Transaction> => {
  const log = (...args: unknown[]) => {
    if (debugMode) {
      logger.debug(...args);
    }
  };

  if (!ctx.alwaysTrueReference && !ctx.alwaysTrueScript) {
    throw new Error(
      "propose: need either an AlwaysTrue reference UTxO or the raw script",
    );
  }

  const network = blaze.provider.network;
  const deposit = cosponsoredProposal.deposit;
  const cosponsorAddress = scriptAddressFromHash(network, ctx.cosponsorHash);
  const stateAddress = scriptAddressFromHash(network, ctx.statePolicyId);

  // Guardrails witnessing (TreasuryWithdrawal / ParameterChange): the ledger
  // runs the constitution guardrails script at the Proposing purpose, so the
  // tx needs the script referenced + a Proposing redeemer. The redeemer is
  // patched into every pass's completed tx (staling and re-deriving field 11),
  // which the sdh fixed point then converges over like any other perturbation.
  const needsGuardrails = actionNeedsGuardrails(cosponsoredProposal.action);
  if (needsGuardrails && !ctx.guardrailsReference) {
    throw new Error(
      `propose: ${cosponsoredProposal.action.kind} needs the guardrails ` +
        "script witnessed but no guardrailsReference was provided",
    );
  }
  const guardrailsCostModels = needsGuardrails
    ? await usedCostModelsV3(blaze.provider)
    : undefined;

  // Decode the anchor URL up front — this also validates that the datum's
  // URL bytes survive the text round trip the field-20 encoder performs.
  const anchorUrlText = anchorUrlHexToText(cosponsoredProposal.anchor.url);

  log(
    `[propose] building for proposal ${ctx.proposalHash.slice(0, 16)}…,`,
    `deposit ${deposit} lovelace, action ${cosponsoredProposal.action.kind}`,
  );

  // ── 1. Gather the pooled Before-UTxOs for THIS proposal ────────────────
  // The on-chain propose() aborts unless EVERY cosponsor input's datum
  // hashes to this proposal, so filtering by procedure hash is mandatory.
  const scriptUtxos = await blaze.provider.getUnspentOutputs(cosponsorAddress);
  const pooled: Core.TransactionUnspentOutput[] = [];
  let pooledTotal = 0n;
  for (const utxo of scriptUtxos) {
    const inline = extractInlineDatum(utxo.output().datum());
    if (!inline) continue;
    let parsed: ReturnType<typeof parse<typeof CosponsorTypes.CosponsorDatum>>;
    try {
      parsed = parse(CosponsorTypes.CosponsorDatum, inline);
    } catch {
      continue; // unparseable stray UTxO — not ours to spend
    }
    if (
      parsed === "After" ||
      typeof parsed !== "object" ||
      !("Before" in parsed)
    ) {
      continue;
    }
    let procedureHash: string;
    try {
      procedureHash = serialize(
        CosponsorTypes.CosponsoredProposalProcedure,
        parsed.Before.cosponsored,
      ).hash();
    } catch {
      continue;
    }
    if (procedureHash !== ctx.proposalHash) continue;
    pooled.push(utxo);
    pooledTotal += utxo.output().amount().coin();
  }

  if (pooled.length === 0) {
    throw new Error(
      "propose: no pooled deposits found for this proposal at the cosponsor address",
    );
  }
  const leftover = computeLeftover(pooledTotal, deposit);
  log(
    `[propose] ${pooled.length} pooled UTxO(s), ${pooledTotal} lovelace,`,
    `leftover ${leftover} lovelace`,
  );

  // ── 2. Locate + parse the state UTxO (spent, not referenced) ───────────
  const stateNftAssetId = ctx.statePolicyId + NFT_ASSET_NAME_HEX;
  const stateUtxos = await blaze.provider.getUnspentOutputs(stateAddress);
  let stateUtxo: Core.TransactionUnspentOutput | undefined;
  let currentMpfRoot: string | undefined;
  for (const utxo of stateUtxos) {
    const multiasset = utxo.output().amount().multiasset();
    if (!multiasset) continue;
    let hasNft = false;
    for (const [assetId, quantity] of multiasset.entries()) {
      if (assetId === stateNftAssetId && quantity > 0n) {
        hasNft = true;
        break;
      }
    }
    if (!hasNft) continue;
    const inline = extractInlineDatum(utxo.output().datum());
    if (!inline) continue; // NFT without a datum is corrupt state — skip
    const stateDatum = parse(CosponsorTypes.CosponsorStateDatum, inline);
    stateUtxo = utxo;
    currentMpfRoot = stateDatum.expiredProposalsMpfRoot;
    break;
  }
  if (!stateUtxo || currentMpfRoot === undefined) {
    throw new Error(
      "propose: could not find the CosponsorState UTxO holding the state NFT",
    );
  }
  // ── 3. TTL, proposal expiration, state datum update ────────────────────
  // On-chain: proposal_expiration = final_validity(tx) + proposal_lifetime,
  // where final_validity is the POSIX-ms upper bound the ledger derives
  // from the ttl slot (begin-of-slot time). slotToUnix mirrors exactly that.
  const validUntil =
    validUntilUnixMs ?? Date.now() + DEFAULT_VALIDITY_WINDOW_MS;
  // `unixToSlot` can return a FRACTIONAL slot when `validUntil` isn't
  // slot-aligned. The tx body's ttl (field 3) is an integer slot (Blaze floors
  // it), so the datum's proposal_expiration MUST be derived from the same
  // integer slot — otherwise `slotToUnix(fractional)` bakes a sub-slot offset
  // into the MPF value that the on-chain `final_validity` (integer slot) can't
  // reproduce, and `mpf_updated_correctly` fails. Floor here to pin both to the
  // same integer slot.
  const ttlSlot = Math.floor(blaze.provider.unixToSlot(validUntil));
  const upperBoundMs = BigInt(blaze.provider.slotToUnix(ttlSlot));
  const proposalExpiration = upperBoundMs + PROPOSAL_LIFETIME;
  const newValueHex = cborUint(proposalExpiration);

  // The state redeemer's MPF proof: `[]` for the first insert into an empty
  // trie, or a real exclusion proof reconstructed from chain history for every
  // subsequent proposal on this deployment.
  let newMpfRoot: string;
  let stateProofCborHex: string | null = null;
  if (currentMpfRoot === NULL_MPF_ROOT) {
    newMpfRoot = mpfRootAfterFirstInsert(ctx.proposalHash, newValueHex);
  } else {
    const queries =
      stateChainQueries ?? defaultStateChainQueries(blaze.provider.network);
    const leaves = await reconstructStateLeaves(queries, {
      stateAssetIdHex: stateNftAssetId,
      proposalLifetimeMs: PROPOSAL_LIFETIME,
      slotToUnixMs: (slot) => BigInt(blaze.provider.slotToUnix(slot)),
    });
    const insertion = await buildStateMpfInsertion(
      leaves,
      ctx.proposalHash,
      newValueHex,
      currentMpfRoot,
    );
    newMpfRoot = insertion.newRootHex;
    stateProofCborHex = insertion.proofCborHex;
    log(
      `[propose] reconstructed ${leaves.length}-leaf trie (root verified),`,
      `inserting new leaf`,
    );
  }
  log(
    `[propose] ttl slot ${ttlSlot}, expiration ${proposalExpiration} ms,`,
    `new MPF root ${newMpfRoot}`,
  );

  const newStateDatum = serialize(CosponsorTypes.CosponsorStateDatum, {
    expiredProposalsMpfRoot: newMpfRoot,
  });
  const stateRedeemerBase = serialize(CosponsorTypes.CosponsorStateRedeemer, {
    proof: [],
    anchorList: [
      {
        url: cosponsoredProposal.anchor.url,
        hash: cosponsoredProposal.anchor.hash,
      },
    ],
  });
  // Splice the real MPF proof (library `toCBOR()`, byte-validated against the
  // on-chain `Proof` encoding) into field 0, keeping the SDK-encoded anchorList
  // (field 1). Empty-trie proposes keep `proof = []`.
  const stateRedeemer = stateProofCborHex
    ? spliceStateProof(stateRedeemerBase, stateProofCborHex)
    : stateRedeemerBase;

  // ── 4. Withdrawal account + collateral placeholders ────────────────────
  const changeAddress = await blaze.wallet.getChangeAddress();
  const rewardAccount = Core.RewardAccount.fromCredential(
    {
      type: Core.CredentialType.ScriptHash,
      hash: Core.Hash28ByteBase16(ctx.cosponsorHash),
    },
    network,
  );

  // Realistic-length placeholders so the pass-1 fee estimate (which the
  // freeze pad has to cover) is close to the real redeemer size.
  const initialState: IFixedPointState = {
    collateralInputs: "d9010281825820" + "00".repeat(32) + "00",
    collateralOutput:
      "82" + cborByteString(changeAddress.toBytes()) + "1a004c4b40",
    collateralFee: "1a00393870",
    sdh: "00".repeat(32),
  };

  // ── 5. Stub evaluator ───────────────────────────────────────────────────
  // complete() must NEVER call the real evaluator: pre-splice the body has
  // no proposal_procedures, so the WPropose body-hash check is guaranteed
  // to fail. Generously padded exUnits are final (never re-evaluated).
  const stubEvaluator: Core.Evaluator = async (tx) => {
    const redeemers = tx.witnessSet().redeemers();
    if (!redeemers) {
      throw new Error("propose: built transaction has no redeemers");
    }
    const values = [...redeemers.values()];
    const weights = values.map((redeemer) =>
      redeemer.tag() === Core.RedeemerTag.Reward
        ? 8n // WPropose does the full CBOR body reconstruction — the hog
        : redeemer.tag() === Core.RedeemerTag.Spend
          ? 3n // state spend re-runs the MPF insert; pooled spends are cheap
          : 1n,
    );
    const totalWeight = weights.reduce((acc, weight) => acc + weight, 0n);
    return Core.Redeemers.fromCore(
      values.map((redeemer, i) => {
        redeemer.setExUnits(
          new Core.ExUnits(
            (STUB_TOTAL_MEM * weights[i]) / totalWeight,
            (STUB_TOTAL_STEPS * weights[i]) / totalWeight,
          ),
        );
        return redeemer.toCore();
      }),
    );
  };

  // ── 6. One build pass ───────────────────────────────────────────────────
  const buildPass = async (
    candidate: IFixedPointState,
    frozenFee: bigint | undefined,
    pinnedCollateral: Core.TransactionUnspentOutput[] | undefined,
  ): Promise<Core.Transaction> => {
    const tx = blaze.newTransaction();

    tx.addReferenceInput(ctx.cosponsorReference);
    tx.addReferenceInput(ctx.stateReference);
    if (needsGuardrails) {
      tx.addReferenceInput(ctx.guardrailsReference!);
    }
    if (ctx.alwaysTrueReference) {
      tx.addReferenceInput(ctx.alwaysTrueReference);
    } else {
      tx.provideScript(ctx.alwaysTrueScript!);
    }

    // Pooled spends. The spend validator ignores the redeemer (it only
    // demands the 0-lovelace withdrawal be present), but each script input
    // still needs a redeemer entry.
    for (const utxo of pooled) {
      tx.addInput(utxo, voidRedeemer());
    }

    // State spend + state continuation output. Non-lovelace value (the NFT)
    // must be preserved; we keep the lovelace identical too.
    tx.addInput(stateUtxo, stateRedeemer);
    tx.lockAssets(stateAddress, stateUtxo.output().amount(), newStateDatum);

    // Surplus pledge back to the pool under the same Before datum (exact
    // amount — enforced on-chain).
    if (leftover > 0n) {
      tx.lockAssets(cosponsorAddress, makeValue(leftover), ctx.beforeDatum);
    }

    // Phantom deposit sink: Blaze knows nothing about the governance
    // deposit that field 20 will consume, so without this output it would
    // route the deposit surplus into wallet change and the spliced
    // transaction would be unbalanced. The phantom output is REMOVED from
    // the body after complete(); the splice then re-consumes exactly this
    // amount as the proposal deposit. (Deviation from the task sheet's
    // implicit assumption that Blaze balances the deposit natively —
    // Blaze cannot, having no governance support.)
    tx.payLovelace(changeAddress, deposit);

    // 0-lovelace withdrawal at the cosponsor script's reward account with
    // the WPropose redeemer carrying the candidate collateral bytes.
    tx.addWithdrawal(
      rewardAccount,
      0n,
      serialize(CosponsorTypes.CosponsorWithdrawRedeemer, {
        WPropose: {
          collateralInputs: candidate.collateralInputs,
          collateralOutput: candidate.collateralOutput,
          collateralFee: candidate.collateralFee,
        },
      }),
    );

    // AlwaysTrue marker token: name = script_data_hash candidate.
    tx.addMint(
      Core.PolicyId(ctx.alwaysTruePolicyId),
      new Map<Core.AssetName, bigint>([[Core.AssetName(candidate.sdh), 1n]]),
      voidRedeemer(),
    );

    tx.setValidUntil(ttlSlot);
    tx.setChangeAddress(changeAddress);
    tx.useEvaluator(stubEvaluator);
    if (frozenFee !== undefined) {
      tx.setMinimumFee(frozenFee);
    }
    if (pinnedCollateral) {
      tx.provideCollateral(pinnedCollateral);
    }
    const completedPass = await tx.complete();
    // Blaze knows nothing about the Proposing purpose, so the guardrails
    // redeemer (and the refreshed script_data_hash) is patched in after
    // complete() — BEFORE the pass's sdh/collateral bytes are observed, so
    // the fixed point (and the AlwaysTrue token name) converge on the
    // patched hash.
    return needsGuardrails
      ? appendProposingRedeemer(completedPass, guardrailsCostModels!)
      : completedPass;
  };

  // Remove the phantom deposit sink and serialize the body. Identified by
  // exact coin + change address + no datum + no tokens (the real change
  // output always carries the freshly minted AlwaysTrue token).
  const stripPhantomAndSerialize = (completed: Core.Transaction): string => {
    const body = completed.body();
    const outputs = [...body.outputs()];
    const changeAddressBytes = changeAddress.toBytes();
    const phantomIndex = outputs.findIndex((output) => {
      const tokens = output.amount().multiasset();
      return (
        output.address().toBytes() === changeAddressBytes &&
        output.amount().coin() === deposit &&
        (!tokens || tokens.size === 0) &&
        !output.datum()
      );
    });
    if (phantomIndex < 0) {
      throw new Error(
        "propose: phantom deposit-sink output not found in the built body",
      );
    }
    outputs.splice(phantomIndex, 1);
    body.setOutputs(outputs);
    // Canonically sort the input + reference-input sets (fields 00, 12) by
    // (txId, index) at the CBOR level. Blaze indexes redeemers against the
    // sorted order the ledger presents in the script context, but serializes
    // the body in insertion order — so the on-chain `metadata_validation`
    // (which reconstructs from the sorted context) hashes a different byte
    // layout than the body and rejects the tx. Sorting the body to match the
    // context fixes the hash; redeemers already assume this order, so no
    // re-indexing is needed. (Done in hex — Blaze's setInputs/CborSet.fromCore
    // does not preserve a supplied canonical order.)
    return canonicalizeBodyInputSets(body.toCbor());
  };

  // ── 7. Fixed point over collateral bytes + script_data_hash ────────────
  let frozenFee: bigint | undefined;
  let pinnedCollateral: Core.TransactionUnspentOutput[] | undefined;

  const fixedPoint = await runFixedPoint<
    IFixedPointState,
    { bodyHex: string; completed: Core.Transaction }
  >(
    initialState,
    async (candidate, iteration) => {
      const completed = await buildPass(candidate, frozenFee, pinnedCollateral);
      if (frozenFee === undefined) {
        // Blaze's fee doesn't price the patched-in guardrails redeemer
        // (exUnits + bytes) — widen the freeze pad to cover it.
        frozenFee =
          completed.body().fee() +
          FEE_FREEZE_PAD +
          (needsGuardrails ? GUARDRAILS_FEE_PAD : 0n);
        log(
          `[propose] pass 1 fee ${completed.body().fee()}, frozen at ${frozenFee}`,
        );
      }
      if (!pinnedCollateral) {
        const collateralInputs = [
          ...(completed.body().collateral()?.values() ?? []),
        ];
        if (collateralInputs.length === 0) {
          throw new Error(
            "propose: Blaze selected no collateral inputs — the wallet needs a pure-ADA collateral UTxO",
          );
        }
        pinnedCollateral =
          await blaze.provider.resolveUnspentOutputs(collateralInputs);
      }
      const bodyHex = stripPhantomAndSerialize(completed);
      const observed: IFixedPointState = {
        ...extractCollateralFieldHex(bodyHex),
        sdh: extractScriptDataHash(bodyHex),
      };
      log(
        `[propose] pass ${iteration + 1}: sdh ${observed.sdh.slice(0, 16)}…,`,
        `collateral fee bytes ${observed.collateralFee}`,
      );
      return { observed, artifact: { bodyHex, completed } };
    },
    (a, b) =>
      a.collateralInputs === b.collateralInputs &&
      a.collateralOutput === b.collateralOutput &&
      a.collateralFee === b.collateralFee &&
      a.sdh === b.sdh,
  );
  log(`[propose] converged after ${fixedPoint.iterations} pass(es)`);

  const { bodyHex, completed } = fixedPoint.artifact;

  // ── 8. Sanity: the body must match the canonical field set exactly ─────
  // (00,01,02,03,05,09,0b,0d,[0e],10,11,[12]) — anything else and the
  // on-chain reconstruction can never hash-match.
  const bodyKeys = listBodyKeys(bodyHex);
  const unexpected = bodyKeys.filter((key) => !ALLOWED_BODY_KEYS.has(key));
  const missing = REQUIRED_BODY_KEYS.filter((key) => !bodyKeys.includes(key));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `propose: built body deviates from the canonical field set ` +
        `(unexpected: [${unexpected.join(",")}], missing: [${missing.join(",")}]); ` +
        "the WPropose reconstruction would reject this transaction",
    );
  }

  // ── 9. Splice proposal_procedures (field 20) and rebuild the tx ────────
  const proposalProceduresHex = encodeProposalProcedures(
    [
      {
        proposal: {
          ...cosponsoredProposal,
          anchor: {
            url: anchorUrlText,
            hash: cosponsoredProposal.anchor.hash,
          },
        },
        returnAddress: { ScriptCredential: [ctx.cosponsorHash] as [string] },
      },
      // Network nibble for the reward-account bytes (testnet 0 / mainnet 1).
    ],
    Number(network),
  );
  const splicedBodyHex = spliceProposalProcedures(
    bodyHex,
    proposalProceduresHex,
  );
  const transactionId = transactionIdFromBody(splicedBodyHex);

  const assembled = new Core.Transaction(
    Core.TransactionBody.fromCbor(HexBlob(splicedBodyHex)),
    completed.witnessSet(),
  );
  // Transaction.toCbor() re-serializes the body with inputs in insertion order
  // even though we built it from a canonically-sorted body — re-apply the sort
  // to the final bytes so the submitted body matches the sorted script context
  // (and hashes to `transactionId`).
  const finalTransaction = Core.Transaction.fromCbor(
    Core.TxCBOR(canonicalizeTransactionInputSets(assembled.toCbor())),
  );

  log(`[propose] final transaction id ${transactionId}`);
  log(
    "[propose] REMINDER: sign the EXACT returned CBOR (CIP-30 signTx with " +
      "partialSign=true); wallets that re-serialize the body will break the id",
  );
  return finalTransaction;
};

/**
 * Node entry point: derives the script context from the parameterized
 * validator classes and the deployed reference scripts, then delegates to
 * {@link proposeWithScriptContext}.
 */
export const propose = async <P extends Provider, W extends Wallet>(
  args: IProposeArgs<P, W>,
): Promise<Core.Transaction> => {
  const { blaze, cosponsoredProposal } = args;

  const cosponsorState = new CosponsorState(
    PROTOCOL_BOOT_TRANSACTION_ID,
    PROTOCOL_BOOT_TRANSACTION_INDEX,
    PROPOSAL_LIFETIME,
  );
  const statePolicyId = cosponsorState.script().hash();
  const cosponsor = Cosponsor.new({ statePolicyId, cosponsoredProposal });
  const cosponsorHash = cosponsor.script().hash();
  const alwaysTrueScript = AlwaysTrue.script();

  const scriptReferenceAddress = Address.fromBech32(SCRIPT_REFERENCE_ADDRESS);
  const cosponsorReference = await blaze.provider.resolveScriptRef(
    cosponsorHash,
    scriptReferenceAddress,
  );
  if (!cosponsorReference) {
    throw new Error("Cosponsor script reference not found");
  }
  const stateReference = await blaze.provider.resolveScriptRef(
    statePolicyId,
    scriptReferenceAddress,
  );
  if (!stateReference) {
    throw new Error("CosponsorState script reference not found");
  }
  const alwaysTrueReference = await blaze.provider.resolveScriptRef(
    alwaysTrueScript.hash(),
    scriptReferenceAddress,
  );

  // Guardrails reference (TreasuryWithdrawal / ProtocolParameters only). The
  // action's `guardRails` hash — when the datum carries one — pins the
  // resolved reference script's identity.
  let guardrailsReference: Core.TransactionUnspentOutput | undefined;
  if (actionNeedsGuardrails(cosponsoredProposal.action)) {
    const expectedHash =
      "guardRails" in cosponsoredProposal.action
        ? cosponsoredProposal.action.guardRails
        : undefined;
    guardrailsReference = await resolveGuardrailsReference(
      blaze.provider,
      expectedHash,
    );
  }

  return proposeWithScriptContext(args, {
    cosponsorHash,
    statePolicyId,
    alwaysTruePolicyId: alwaysTrueScript.hash(),
    proposalHash: cosponsor.gAda(),
    beforeDatum: cosponsor.datum(),
    cosponsorReference,
    stateReference,
    alwaysTrueReference: alwaysTrueReference ?? undefined,
    alwaysTrueScript: Core.Script.newPlutusV3Script(alwaysTrueScript),
    guardrailsReference,
  });
};
