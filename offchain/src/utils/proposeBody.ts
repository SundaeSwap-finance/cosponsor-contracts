/**
 * Canonical Conway-body encoding for the Propose transaction.
 *
 * The on-chain `metadata_validation` (lib/calculation/cosponsor.ak)
 * reconstructs the transaction body CBOR byte-for-byte and requires
 * `transaction.id == blake2b_256(body)`. Blaze/cardano-sdk produce every
 * body field EXCEPT `proposal_procedures` (key 20) — Blaze has no
 * governance support — so the builder serializes that field here, splices
 * it into the Blaze-built body, and recomputes the transaction id.
 *
 * Byte-level contract: these encoders mirror `lib/calculation/conversion.ak`
 * exactly; the golden vectors in validators/tests/propose_proof.ak and
 * tests/propose-body-golden.test.ts are the shared lock between the two.
 *
 * NETWORK NOTE: reward-account header bytes carry the network nibble
 * (testnet 0xe0/0xf0, mainnet 0xe1/0xf1). Every encoder takes a `networkId`
 * (Core.NetworkId: 0 = testnet, 1 = mainnet) defaulting to testnet; the
 * propose builder passes the provider's network. (Since the WPropose
 * redesign the on-chain side compares against the V3 context, which drops
 * the network tag — only this ledger-facing encoding needs it.)
 */

import { blake2b_256, HexBlob } from "@blaze-cardano/core";
import type { ICosponsoredProposal } from "@validators/Cosponsor.js";
import type {
  IGovernanceActionId,
  TGovernanceAction,
  TProtocolParamValue,
} from "@validators/Types/GovernanceAction.js";
import { sortedParamEntries } from "@validators/Types/GovernanceAction.js";
import type { TCredential } from "@validators/Types/Credential.js";

const CONWAY_SET_TAG = "d90102";

/** CBOR definite-length header for the given major type base. */
function cborHeader(majorBase: number, n: number): string {
  if (n <= 23) {
    return (majorBase + n).toString(16).padStart(2, "0");
  }
  if (n <= 255) {
    return (
      (majorBase + 24).toString(16).padStart(2, "0") +
      n.toString(16).padStart(2, "0")
    );
  }
  if (n <= 65535) {
    return (
      (majorBase + 25).toString(16).padStart(2, "0") +
      n.toString(16).padStart(4, "0")
    );
  }
  throw new Error(`cborHeader: length too large: ${n}`);
}

const arrayHeader = (n: number) => cborHeader(0x80, n);
const mapHeader = (n: number) => cborHeader(0xa0, n);
const textHeader = (n: number) => cborHeader(0x60, n);

/** CBOR unsigned integer (matches Aiken's serialise for non-negative ints). */
export function cborUint(value: bigint | number): string {
  const v = BigInt(value);
  if (v < 0n) throw new Error("cborUint: negative");
  if (v <= 23n) return v.toString(16).padStart(2, "0");
  if (v <= 0xffn) return "18" + v.toString(16).padStart(2, "0");
  if (v <= 0xffffn) return "19" + v.toString(16).padStart(4, "0");
  if (v <= 0xffffffffn) return "1a" + v.toString(16).padStart(8, "0");
  if (v <= 0xffffffffffffffffn) return "1b" + v.toString(16).padStart(16, "0");
  throw new Error("cborUint: too large");
}

// Accept BOTH the SDK's friendly `TCredential` (`{ vkey }` / `{ script }`) and
// the on-chain contract form (`{ VerificationKeyCredential: [h] }` /
// `{ ScriptCredential: [h] }`). Propose.ts spreads `cosponsoredProposal` (whose
// `beneficiaries` are `TCredential`) AND passes `returnAddress` in the on-chain
// form, so this encoder must normalize both — otherwise TreasuryWithdrawal /
// ConstitutionalCommittee actions (the only ones carrying credentials) throw at
// encode time. NicePoll/HardFork/NoConfidence have no credentials, which is why
// this went unnoticed until the first TreasuryWithdrawal test.
type TAnyCredential =
  | TCredential
  | { VerificationKeyCredential: [string] }
  | { ScriptCredential: [string] };

function credentialParts(credential: TAnyCredential): {
  isScript: boolean;
  hash: string;
} {
  if ("ScriptCredential" in credential) {
    return { isScript: true, hash: credential.ScriptCredential[0] };
  }
  if ("VerificationKeyCredential" in credential) {
    return { isScript: false, hash: credential.VerificationKeyCredential[0] };
  }
  if ("script" in credential) {
    return { isScript: true, hash: credential.script };
  }
  if ("vkey" in credential) {
    return { isScript: false, hash: credential.vkey };
  }
  throw new Error("credentialParts: unrecognized credential shape");
}

/**
 * Reward-account bytes: header + hash28, as bytes29. Header = type nibble
 * (0xe key / 0xf script) | network nibble (0 testnet, 1 mainnet).
 */
export function encodeRewardAccount(
  credential: TAnyCredential,
  networkId: number = 0,
): string {
  const { isScript, hash } = credentialParts(credential);
  if (hash.length !== 56) {
    throw new Error("encodeRewardAccount: credential hash must be 28 bytes");
  }
  if (networkId !== 0 && networkId !== 1) {
    throw new Error(`encodeRewardAccount: bad networkId ${networkId}`);
  }
  const header = ((isScript ? 0xf0 : 0xe0) | networkId)
    .toString(16)
    .padStart(2, "0");
  return "581d" + header + hash;
}

/** Ledger credential: [0, key_hash] / [1, script_hash]. */
function encodeCredential(credential: TAnyCredential): string {
  const { isScript, hash } = credentialParts(credential);
  return (isScript ? "8201581c" : "8200581c") + hash;
}

function encodeActionId(ancestor: IGovernanceActionId | null): string {
  if (!ancestor) return "f6";
  return "825820" + ancestor.txHash + cborUint(ancestor.index);
}

function encodeOptionScriptHash(hash: string | undefined): string {
  return hash ? "581c" + hash : "f6";
}

/**
 * One `protocol_param_update` value (Conway CDDL): integers as plain uints,
 * unit/nonnegative intervals as tag-30 rationals `#6.30([num, den])`.
 */
function encodeParamValue(value: TProtocolParamValue): string {
  if (typeof value === "bigint") {
    return cborUint(value);
  }
  return "d81e82" + cborUint(value.numerator) + cborUint(value.denominator);
}

function beneficiaryEntries(
  beneficiaries:
    | Map<TCredential, bigint>
    | Array<[TCredential, bigint | string]>,
): Array<[TCredential, bigint]> {
  const entries =
    beneficiaries instanceof Map
      ? Array.from(beneficiaries.entries())
      : beneficiaries;
  return entries.map(([cred, amount]) => [cred, BigInt(amount)]);
}

/** Ledger gov_action bytes (Conway `gov_action` CDDL). */
export function encodeGovernanceAction(
  action: TGovernanceAction,
  networkId: number = 0,
): string {
  switch (action.kind) {
    case "NicePoll":
      return "8106";
    case "NoConfidence":
      return "8203" + encodeActionId(action.ancestor);
    case "HardFork":
      return (
        "8301" +
        encodeActionId(action.ancestor) +
        "82" +
        cborUint(action.version.major) +
        cborUint(action.version.minor)
      );
    case "TreasuryWithdrawal": {
      const entries = beneficiaryEntries(action.beneficiaries);
      const body = entries
        .map(
          ([cred, amount]) =>
            encodeRewardAccount(cred, networkId) + cborUint(amount),
        )
        .join("");
      return (
        "8302" +
        mapHeader(entries.length) +
        body +
        encodeOptionScriptHash(action.guardRails)
      );
    }
    case "ConstitutionalCommittee": {
      const added = beneficiaryEntries(action.membersToAdd);
      return (
        "8504" +
        encodeActionId(action.ancestor) +
        CONWAY_SET_TAG +
        arrayHeader(action.membersToRemove.length) +
        action.membersToRemove.map(encodeCredential).join("") +
        mapHeader(added.length) +
        added
          .map(([cred, mandate]) => encodeCredential(cred) + cborUint(mandate))
          .join("") +
        "d81e82" +
        cborUint(action.quorum.numerator) +
        cborUint(action.quorum.denominator)
      );
    }
    case "ProtocolParameters": {
      // parameter_change_action =
      //   [0, gov_action_id / nil, protocol_param_update, policy_hash / nil]
      // The datum representation (Pairs<Int, Data>) and this CBOR encoding
      // must describe the SAME update: the ledger translates this map back
      // into the script context's ChangedParameters Data, which propose()
      // compares structurally against the datum. Entries ascending by id.
      const entries = sortedParamEntries(action.newParameters);
      if (entries.length === 0) {
        throw new Error(
          "encodeGovernanceAction: ProtocolParameters needs a NON-empty " +
            "newParameters update (the ledger rejects empty as MalformedProposal)",
        );
      }
      const update = entries
        .map(([id, value]) => cborUint(id) + encodeParamValue(value))
        .join("");
      return (
        "8400" +
        encodeActionId(action.ancestor) +
        mapHeader(entries.length) +
        update +
        encodeOptionScriptHash(action.guardRails)
      );
    }
    case "NewConstitution": {
      // new_constitution = (5, gov_action_id / null, constitution)
      // constitution    = [anchor, script_hash / null]
      // The constitution anchor has NO datum slot (the V3 context drops it),
      // so it arrives as the SDK-side `constitutionAnchor` — see the trust-gap
      // note on INewConstitution. Refuse to build without it: the node
      // rejects a constitution missing its anchor as malformed.
      if (!action.constitutionAnchor) {
        throw new Error(
          "encodeGovernanceAction: NewConstitution needs `constitutionAnchor` " +
            "(url + blake2b-256 hash of the constitution document) — the " +
            "ledger requires it even though the datum cannot commit it",
        );
      }
      return (
        "8305" +
        encodeActionId(action.ancestor) +
        "82" +
        encodeAnchor(action.constitutionAnchor) +
        encodeOptionScriptHash(action.guardrails)
      );
    }
    default:
      throw new Error(
        `encodeGovernanceAction: unknown kind ${(action as { kind: string }).kind}`,
      );
  }
}

function encodeAnchor(anchor: { url: string; hash: string }): string {
  const urlHex = Buffer.from(anchor.url, "utf8").toString("hex");
  if (anchor.hash.length !== 64) {
    throw new Error("encodeAnchor: hash must be 32 bytes of hex");
  }
  return "82" + textHeader(urlHex.length / 2) + urlHex + "5820" + anchor.hash;
}

/**
 * One ledger proposal_procedure:
 *   [deposit, reward_account, gov_action, anchor]
 * `returnAddress` is the credential the deposit refund goes to — for
 * CoSponsor always the cosponsor script credential (fixed at deposit time).
 */
export function encodeProposalProcedure(
  proposal: ICosponsoredProposal,
  returnAddress: TAnyCredential,
  networkId: number = 0,
): string {
  return (
    "84" +
    cborUint(proposal.deposit) +
    encodeRewardAccount(returnAddress, networkId) +
    encodeGovernanceAction(proposal.action, networkId) +
    encodeAnchor(proposal.anchor)
  );
}

/** Body field 20: Conway nonempty_set of proposal_procedure. */
export function encodeProposalProcedures(
  proposals: Array<{
    proposal: ICosponsoredProposal;
    returnAddress: TAnyCredential;
  }>,
  networkId: number = 0,
): string {
  return (
    CONWAY_SET_TAG +
    arrayHeader(proposals.length) +
    proposals
      .map(({ proposal, returnAddress }) =>
        encodeProposalProcedure(proposal, returnAddress, networkId),
      )
      .join("")
  );
}

/**
 * Splices `proposal_procedures` (key 20) into a Blaze-built body.
 *
 * Every key Blaze emits for our transactions is < 20, so the field appends
 * at the end; the map arity in the leading header is bumped by one.
 */
export function spliceProposalProcedures(
  bodyHex: string,
  proposalProceduresHex: string,
): string {
  const header = parseInt(bodyHex.slice(0, 2), 16);
  let count: number;
  let rest: string;
  if (header >= 0xa0 && header <= 0xb7) {
    count = header - 0xa0;
    rest = bodyHex.slice(2);
  } else if (header === 0xb8) {
    count = parseInt(bodyHex.slice(2, 4), 16);
    rest = bodyHex.slice(4);
  } else {
    throw new Error(
      `spliceProposalProcedures: unsupported body map header 0x${header.toString(16)}`,
    );
  }
  if (rest.includes("14" + CONWAY_SET_TAG) && rest.endsWith("14")) {
    // Defensive only — Blaze cannot emit key 20 today.
    throw new Error("spliceProposalProcedures: body already has key 20");
  }
  return mapHeader(count + 1) + rest + "14" + proposalProceduresHex;
}

/** The transaction id: blake2b-256 of the body bytes. */
export function transactionIdFromBody(bodyHex: string): string {
  return blake2b_256(HexBlob(bodyHex));
}
