/**
 * Pure helpers for the Propose transaction builder
 * (src/transactions/Propose.ts).
 *
 * Everything here is deterministic and network-free so it can be unit
 * tested directly (tests/propose-builder.test.ts):
 *
 * - a small CBOR field extractor used to pull the RAW bytes of the
 *   collateral body fields (13 / 16 / 17) and the script_data_hash (11)
 *   out of a Blaze-built transaction body, exactly as serialized — those
 *   bytes go verbatim into the on-chain WPropose redeemer;
 * - the Merkle Patricia Forestry root for the first insert into an EMPTY
 *   trie (the `cosponsor_state` datum update);
 * - the generic fixed-point runner the builder uses to converge the
 *   collateral-bytes / script-data-hash feedback loop;
 * - leftover (surplus pledge) arithmetic.
 */

import { blake2b_256, HexBlob } from "@blaze-cardano/core";

// ---------------------------------------------------------------------------
// CBOR primitives
// ---------------------------------------------------------------------------

interface ICborHeader {
  /** CBOR major type (0-7). */
  major: number;
  /** Additional-info bits (0-31). */
  ai: number;
  /** Decoded argument (length, uint value, tag number, ...). */
  value: bigint;
  /** Total header size in hex characters (initial byte + argument bytes). */
  headerChars: number;
}

const readCborHeader = (hex: string, pos: number): ICborHeader => {
  const initial = parseInt(hex.slice(pos, pos + 2), 16);
  if (Number.isNaN(initial)) {
    throw new Error(`readCborHeader: out of bounds at ${pos}`);
  }
  const major = initial >> 5;
  const ai = initial & 0x1f;
  if (ai < 24) {
    return { major, ai, value: BigInt(ai), headerChars: 2 };
  }
  const argBytes =
    ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : ai === 27 ? 8 : -1;
  if (argBytes < 0) {
    // cardano-sdk only emits definite-length items; 28-30 are reserved and
    // 31 is the indefinite-length / break marker.
    throw new Error(
      `readCborHeader: unsupported additional info ${ai} at ${pos} (indefinite lengths are never emitted by cardano-sdk)`,
    );
  }
  const end = pos + 2 + argBytes * 2;
  if (end > hex.length) {
    throw new Error(`readCborHeader: truncated argument at ${pos}`);
  }
  return {
    major,
    ai,
    value: BigInt("0x" + hex.slice(pos + 2, end)),
    headerChars: 2 + argBytes * 2,
  };
};

/**
 * Skip one complete CBOR item starting at `pos` (hex-character offset) and
 * return the offset just past it. Definite lengths only.
 */
export const skipCborItem = (hex: string, pos: number): number => {
  const header = readCborHeader(hex, pos);
  let cursor = pos + header.headerChars;
  switch (header.major) {
    case 0: // unsigned int — argument fully consumed by the header
    case 1: // negative int
      return cursor;
    case 2: // byte string
    case 3: // text string
      cursor += Number(header.value) * 2;
      if (cursor > hex.length) {
        throw new Error(`skipCborItem: truncated string at ${pos}`);
      }
      return cursor;
    case 4: {
      // array
      for (let i = 0; i < Number(header.value); i++) {
        cursor = skipCborItem(hex, cursor);
      }
      return cursor;
    }
    case 5: {
      // map — 2 items per entry
      for (let i = 0; i < Number(header.value) * 2; i++) {
        cursor = skipCborItem(hex, cursor);
      }
      return cursor;
    }
    case 6: // tag — the tag number is in the header; one nested item follows
      return skipCborItem(hex, cursor);
    case 7: // simple values / floats — argument fully consumed by the header
      return cursor;
    default:
      throw new Error(`skipCborItem: unreachable major type ${header.major}`);
  }
};

/** CBOR byte-string encoding (header + payload) of the given hex bytes. */
export const cborByteString = (payloadHex: string): string => {
  const length = payloadHex.length / 2;
  if (!Number.isInteger(length)) {
    throw new Error("cborByteString: odd-length hex payload");
  }
  if (length <= 23) {
    return (0x40 + length).toString(16).padStart(2, "0") + payloadHex;
  }
  if (length <= 255) {
    return "58" + length.toString(16).padStart(2, "0") + payloadHex;
  }
  if (length <= 65535) {
    return "59" + length.toString(16).padStart(4, "0") + payloadHex;
  }
  throw new Error(`cborByteString: payload too large (${length} bytes)`);
};

// ---------------------------------------------------------------------------
// Transaction-body field extraction
// ---------------------------------------------------------------------------

/** All top-level keys of a transaction-body CBOR map, in serialized order. */
export const listBodyKeys = (bodyHex: string): number[] => {
  const header = readCborHeader(bodyHex, 0);
  if (header.major !== 5) {
    throw new Error("listBodyKeys: transaction body is not a CBOR map");
  }
  const keys: number[] = [];
  let cursor = header.headerChars;
  for (let i = 0; i < Number(header.value); i++) {
    const keyHeader = readCborHeader(bodyHex, cursor);
    if (keyHeader.major !== 0) {
      throw new Error(`listBodyKeys: non-uint body key at entry ${i}`);
    }
    keys.push(Number(keyHeader.value));
    cursor = skipCborItem(bodyHex, cursor); // key
    cursor = skipCborItem(bodyHex, cursor); // value
  }
  return keys;
};

/**
 * Extract the RAW serialized value bytes of a top-level body field, exactly
 * as they appear in the body CBOR (no re-encoding). Returns `undefined` when
 * the key is absent.
 */
export const extractBodyField = (
  bodyHex: string,
  key: number,
): string | undefined => {
  const header = readCborHeader(bodyHex, 0);
  if (header.major !== 5) {
    throw new Error("extractBodyField: transaction body is not a CBOR map");
  }
  let cursor = header.headerChars;
  for (let i = 0; i < Number(header.value); i++) {
    const keyHeader = readCborHeader(bodyHex, cursor);
    if (keyHeader.major !== 0) {
      throw new Error(`extractBodyField: non-uint body key at entry ${i}`);
    }
    const entryKey = Number(keyHeader.value);
    cursor += keyHeader.headerChars;
    const valueEnd = skipCborItem(bodyHex, cursor);
    if (entryKey === key) {
      return bodyHex.slice(cursor, valueEnd);
    }
    cursor = valueEnd;
  }
  return undefined;
};

/**
 * The three collateral body fields the WPropose redeemer must carry
 * byte-for-byte (they are invisible to the script context):
 * 13 = collateral inputs, 16 = collateral return, 17 = total collateral.
 */
export interface ICollateralFieldHex {
  collateralInputs: string;
  collateralOutput: string;
  collateralFee: string;
}

export const extractCollateralFieldHex = (
  bodyHex: string,
): ICollateralFieldHex => {
  const collateralInputs = extractBodyField(bodyHex, 13);
  const collateralOutput = extractBodyField(bodyHex, 16);
  const collateralFee = extractBodyField(bodyHex, 17);
  if (!collateralInputs || !collateralOutput || !collateralFee) {
    throw new Error(
      "extractCollateralFieldHex: built body is missing a collateral field " +
        `(13:${!!collateralInputs} 16:${!!collateralOutput} 17:${!!collateralFee}). ` +
        "The on-chain reconstruction requires all three; make sure the wallet " +
        "has a collateral UTxO strictly larger than the total collateral so " +
        "Blaze emits a collateral-return output.",
    );
  }
  return { collateralInputs, collateralOutput, collateralFee };
};

/** script_data_hash (body key 11) as a bare 32-byte hex string. */
export const extractScriptDataHash = (bodyHex: string): string => {
  const field = extractBodyField(bodyHex, 11);
  if (!field || !field.startsWith("5820")) {
    throw new Error(
      "extractScriptDataHash: body has no script_data_hash (key 11)",
    );
  }
  return field.slice(4);
};

// ---------------------------------------------------------------------------
// Merkle Patricia Forestry (aiken-lang/merkle-patricia-forestry)
// ---------------------------------------------------------------------------

/** Root of an empty MPF trie (null hash, 32 zero bytes). */
export const NULL_MPF_ROOT = "00".repeat(32);

/**
 * Root of an MPF trie after inserting the FIRST element into an EMPTY trie
 * (proof = []). Mirrors `aiken/merkle_patricia_forestry.insert` for the
 * empty-proof case:
 *
 *   including(key, value, []) = combine(suffix(blake2b_256(key), 0),
 *                                       blake2b_256(value))
 *   suffix(path, 0)           = 0xff || path
 *   combine(l, r)             = blake2b_256(l || r)
 *
 * This shortcut is only for the FIRST insert (empty trie). Inserts into a
 * NON-empty trie are handled by `mpfReconstruct.ts` (`buildStateMpfInsertion`),
 * which reconstructs the trie from chain history and produces a real proof via
 * `@aiken-lang/merkle-patricia-forestry`.
 */
export const mpfRootAfterFirstInsert = (
  keyHex: string,
  valueHex: string,
): string => {
  const path = blake2b_256(HexBlob(keyHex));
  const valueHash = blake2b_256(HexBlob(valueHex));
  return blake2b_256(HexBlob("ff" + path + valueHash));
};

// ---------------------------------------------------------------------------
// Fixed point
// ---------------------------------------------------------------------------

export interface IFixedPointResult<T, A> {
  /** The converged value (step(value) observed == value). */
  value: T;
  /** The artifact produced by the converged iteration. */
  artifact: A;
  /** Number of iterations executed (including the converged one). */
  iterations: number;
}

/**
 * Run `step` until the observed value equals the candidate that produced it.
 *
 * The Propose builder feeds the collateral bytes + script_data_hash observed
 * in a completed body back into the next build (redeemer + mint token name).
 * Collateral bytes freeze once the fee and collateral inputs are pinned, and
 * the script data hash is a function of the redeemer bytes only, so the loop
 * converges in <= 4 iterations in practice.
 */
export const runFixedPoint = async <T, A>(
  initial: T,
  step: (
    candidate: T,
    iteration: number,
  ) => Promise<{ observed: T; artifact: A }>,
  equals: (a: T, b: T) => boolean,
  maxIterations = 6,
): Promise<IFixedPointResult<T, A>> => {
  let candidate = initial;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const { observed, artifact } = await step(candidate, iteration);
    if (equals(observed, candidate)) {
      return { value: observed, artifact, iterations: iteration + 1 };
    }
    candidate = observed;
  }
  throw new Error(
    `runFixedPoint: no convergence after ${maxIterations} iterations`,
  );
};

// ---------------------------------------------------------------------------
// Leftover math
// ---------------------------------------------------------------------------

/**
 * Minimum lovelace the leftover (surplus pledge) output must carry. The
 * on-chain check is EXACT (`input_ada - deposit == output_ada`), so a
 * sub-min-ada leftover cannot be padded — the propose has to wait for more
 * pledges (or a pool that divides exactly).
 */
export const MIN_LEFTOVER_LOVELACE = 1_500_000n;

/**
 * Surplus pooled lovelace that must return to the cosponsor script under a
 * `Before` datum. Throws when the pool cannot fund the deposit, or when the
 * surplus is positive but below min-ada (the exact-preservation rule makes
 * such a transaction unbuildable).
 */
export const computeLeftover = (
  pooledTotal: bigint,
  deposit: bigint,
  minLeftover: bigint = MIN_LEFTOVER_LOVELACE,
): bigint => {
  if (pooledTotal < deposit) {
    throw new Error(
      `computeLeftover: pooled funds (${pooledTotal} lovelace) do not cover ` +
        `the proposal deposit (${deposit} lovelace)`,
    );
  }
  const leftover = pooledTotal - deposit;
  if (leftover > 0n && leftover < minLeftover) {
    throw new Error(
      `computeLeftover: leftover ${leftover} lovelace is below the minimum ` +
        `UTxO value (~${minLeftover}); the on-chain rule requires the exact ` +
        "surplus to return to the script, so this propose cannot be built. " +
        "Wait for additional pledges before submitting.",
    );
  }
  return leftover;
};

// ---------------------------------------------------------------------------
// Anchor URL convention bridge
// ---------------------------------------------------------------------------

/**
 * `ICosponsoredProposal.anchor.url` is hex-encoded bytes throughout the SDK
 * (datum convention), while `encodeProposalProcedure` in proposeBody.ts —
 * locked by the Aiken golden vectors — takes the plain-text URL. Decode the
 * hex to text and verify the round trip is lossless so the field-20 bytes
 * are guaranteed to match the datum bytes the validator hashes.
 */
export const anchorUrlHexToText = (urlHex: string): string => {
  const text = Buffer.from(urlHex, "hex").toString("utf8");
  if (Buffer.from(text, "utf8").toString("hex") !== urlHex.toLowerCase()) {
    throw new Error(
      "anchorUrlHexToText: anchor URL bytes are not valid UTF-8; cannot " +
        "encode proposal_procedures losslessly",
    );
  }
  return text;
};

/**
 * Canonically sort the input-set body fields (00 inputs, 12 reference inputs)
 * by (txId, index) at the CBOR-hex level. cardano-sdk/Blaze serializes these
 * sets in insertion order, but the Plutus script context presents them sorted;
 * the on-chain `metadata_validation` reconstructs from the sorted context, so
 * the body must be sorted to match or the tx-id hash check fails. Redeemer
 * input-indices already target the sorted order, so this needs no re-indexing.
 */
export const canonicalizeBodyInputSets = (bodyHex: string): string => {
  const mapHeader = readCborHeader(bodyHex, 0);
  if (mapHeader.major !== 5) {
    throw new Error("canonicalizeBodyInputSets: body is not a CBOR map");
  }
  const entries = Number(mapHeader.value);
  let cursor = mapHeader.headerChars;
  let out = bodyHex.slice(0, cursor);
  for (let i = 0; i < entries; i++) {
    const keyHeader = readCborHeader(bodyHex, cursor);
    const keyHex = bodyHex.slice(cursor, cursor + keyHeader.headerChars);
    const key = Number(keyHeader.value);
    cursor += keyHeader.headerChars;
    const valueStart = cursor;
    cursor = skipCborItem(bodyHex, cursor);
    const valueHex = bodyHex.slice(valueStart, cursor);
    out +=
      keyHex + (key === 0 || key === 18 ? sortInputSetHex(valueHex) : valueHex);
  }
  return out;
};

const sortInputSetHex = (setHex: string): string => {
  let pos = 0;
  let prefixHex = "";
  // Optional Conway set tag 258 (0xd90102) wrapping the array.
  const first = readCborHeader(setHex, pos);
  if (first.major === 6) {
    prefixHex += setHex.slice(pos, pos + first.headerChars);
    pos += first.headerChars;
  }
  const arr = readCborHeader(setHex, pos);
  if (arr.major !== 4) {
    throw new Error("sortInputSetHex: expected a CBOR array of inputs");
  }
  prefixHex += setHex.slice(pos, pos + arr.headerChars);
  pos += arr.headerChars;
  const count = Number(arr.value);
  const items: { txid: string; index: bigint; hex: string }[] = [];
  for (let i = 0; i < count; i++) {
    const start = pos;
    const pair = readCborHeader(setHex, pos); // [txid, index]
    pos += pair.headerChars;
    const txidHeader = readCborHeader(setHex, pos); // bytes(32)
    pos += txidHeader.headerChars;
    const txid = setHex.slice(pos, pos + Number(txidHeader.value) * 2);
    pos += Number(txidHeader.value) * 2;
    const idxHeader = readCborHeader(setHex, pos); // uint (index)
    pos += idxHeader.headerChars;
    items.push({ txid, index: idxHeader.value, hex: setHex.slice(start, pos) });
  }
  items.sort((a, b) =>
    a.txid < b.txid
      ? -1
      : a.txid > b.txid
        ? 1
        : a.index < b.index
          ? -1
          : a.index > b.index
            ? 1
            : 0,
  );
  return prefixHex + items.map((e) => e.hex).join("");
};

/**
 * Apply {@link canonicalizeBodyInputSets} to the body inside a full transaction
 * CBOR. cardano-sdk's `TransactionBody.toCbor()` emits sorted input sets, but
 * `Transaction.toCbor()` re-serializes the body with inputs in insertion order
 * — so the sort must be re-applied to the final tx bytes (the ones actually
 * submitted and hashed), not just the standalone body.
 */
export const canonicalizeTransactionInputSets = (txHex: string): string => {
  const arrayHeader = readCborHeader(txHex, 0);
  if (arrayHeader.major !== 4) {
    throw new Error("canonicalizeTransactionInputSets: tx is not a CBOR array");
  }
  const bodyStart = arrayHeader.headerChars;
  const bodyEnd = skipCborItem(txHex, bodyStart);
  const sortedBody = canonicalizeBodyInputSets(txHex.slice(bodyStart, bodyEnd));
  return txHex.slice(0, bodyStart) + sortedBody + txHex.slice(bodyEnd);
};
