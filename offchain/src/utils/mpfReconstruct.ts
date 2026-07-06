/**
 * Multi-entry Merkle Patricia Forestry support for the `cosponsor_state`
 * update in Propose.ts.
 *
 * The on-chain state UTxO commits only to the MPF *root*; it does not carry the
 * trie's contents. To insert a new (proposalHash → expiration) leaf into a
 * NON-empty trie, the off-chain builder must supply a real inclusion/exclusion
 * proof, which requires reconstructing the current trie from chain data.
 *
 * Reconstruction is fully TRUSTLESS and SELF-VERIFYING:
 *   1. The state NFT is spent+recreated by every propose, so its transaction
 *      history IS the ordered list of proposes (the first tx is the mint).
 *   2. The trie is INSERT-ONLY (cosponsor_state only inserts; cosponsor.redeem
 *      only does membership `has` — nothing ever deletes), so replaying every
 *      propose's inserted leaf reproduces the current trie.
 *   3. Each propose's leaf is derived exactly as the validator derives it:
 *        key   = blake2b_256(cbor(cosponsored))   — from a spent Before datum
 *        value = serialise(slotToUnix(ttl) + PROPOSAL_LIFETIME)
 *   4. The rebuilt root is asserted equal to the on-chain root BEFORE any proof
 *      is trusted. A mismatch throws — we never build a tx on a bad trie.
 *
 * The MPF library (`@aiken-lang/merkle-patricia-forestry`) is imported lazily
 * so it (and its `level` dependency) never enters the browser bundle — this
 * path only runs in the Node/offchain propose flow against a real chain index.
 */

import { blake2b_256, HexBlob } from "@blaze-cardano/core";
import { Core } from "@blaze-cardano/sdk";
import { cborUint } from "./proposeBody.js";

/** One trie leaf: hashed key + CBOR-encoded value, both as hex. */
export interface IMpfLeaf {
  keyHex: string;
  valueHex: string;
}

/**
 * Minimal chain-index surface the reconstruction needs. Implemented for
 * Blockfrost below; a Kupo/other implementation can be dropped in for other
 * providers without touching the reconstruction logic.
 */
export interface IStateChainQueries {
  /** All tx hashes that moved `assetIdHex`, oldest first (mint is index 0). */
  assetTransactions(assetIdHex: string): Promise<string[]>;
  /** Resolved inputs of a tx: their address + inline datum CBOR (if any). */
  txInputs(
    txHash: string,
  ): Promise<Array<{ address: string; inlineDatumHex?: string }>>;
  /** The tx's ttl (invalid_hereafter) slot. */
  txTtlSlot(txHash: string): Promise<number>;
}

const BLOCKFROST_BASE: Record<string, string> = {
  "cardano-preview": "https://cardano-preview.blockfrost.io/api/v0",
  "cardano-preprod": "https://cardano-preprod.blockfrost.io/api/v0",
  "cardano-mainnet": "https://cardano-mainnet.blockfrost.io/api/v0",
};

/** Blockfrost-backed {@link IStateChainQueries}. */
export const blockfrostStateChainQueries = (
  projectId: string,
  network: string,
): IStateChainQueries => {
  const base = BLOCKFROST_BASE[network];
  if (!base) throw new Error(`mpf reconstruct: unsupported network ${network}`);
  const get = async (path: string): Promise<unknown> => {
    const res = await fetch(base + path, {
      headers: { project_id: projectId },
    });
    if (!res.ok) {
      throw new Error(`Blockfrost ${path} → ${res.status}`);
    }
    return res.json();
  };
  return {
    async assetTransactions(assetIdHex) {
      const out: string[] = [];
      for (let page = 1; ; page++) {
        const rows = (await get(
          `/assets/${assetIdHex}/transactions?order=asc&count=100&page=${page}`,
        )) as Array<{ tx_hash: string }>;
        out.push(...rows.map((r) => r.tx_hash));
        if (rows.length < 100) break;
      }
      return out;
    },
    async txInputs(txHash) {
      const u = (await get(`/txs/${txHash}/utxos`)) as {
        inputs: Array<{ address: string; inline_datum?: string | null }>;
      };
      return u.inputs.map((i) => ({
        address: i.address,
        inlineDatumHex: i.inline_datum ?? undefined,
      }));
    },
    async txTtlSlot(txHash) {
      const { cbor } = (await get(`/txs/${txHash}/cbor`)) as { cbor: string };
      const ttl = Core.Transaction.fromCbor(Core.TxCBOR(cbor)).body().ttl();
      if (ttl === undefined) {
        throw new Error(`mpf reconstruct: propose tx ${txHash} has no ttl`);
      }
      return Number(ttl);
    },
  };
};

/**
 * Derive the trie key a propose tx inserted: `blake2b_256(cbor(cosponsored))`
 * of any spent Before UTxO's datum. The state datum is also a ctor-0 Constr,
 * but its field 0 is the root *bytes*; a Before datum's field 0 is the
 * `cosponsored` *Constr* — that structural difference picks the Before inputs.
 * All Before inputs of one propose share the same cosponsored (enforced by the
 * on-chain cross-proposal guard), so the first match is authoritative.
 */
const keyFromProposeInputs = (
  inputs: Array<{ address: string; inlineDatumHex?: string }>,
): string | undefined => {
  for (const input of inputs) {
    if (!input.inlineDatumHex) continue;
    let field0: Core.PlutusData;
    try {
      const constr = Core.PlutusData.fromCbor(HexBlob(input.inlineDatumHex))
        .asConstrPlutusData();
      if (!constr || constr.getAlternative() !== 0n) continue; // not Before
      field0 = constr.getData().get(0);
    } catch {
      continue;
    }
    if (!field0.asConstrPlutusData()) continue; // state datum (bytes) → skip
    return blake2b_256(HexBlob(field0.toCbor()));
  }
  return undefined;
};

/**
 * Rebuild the leaf set of the current state trie from chain history.
 * Throws if any propose tx lacks a resolvable Before-datum key.
 */
export const reconstructStateLeaves = async (
  queries: IStateChainQueries,
  opts: {
    stateAssetIdHex: string;
    proposalLifetimeMs: bigint;
    slotToUnixMs: (slot: number) => bigint;
  },
): Promise<IMpfLeaf[]> => {
  const txs = await queries.assetTransactions(opts.stateAssetIdHex);
  // txs[0] is the mint (empty trie); every later tx is a propose insert.
  const proposeTxs = txs.slice(1);
  const leaves: IMpfLeaf[] = [];
  for (const txHash of proposeTxs) {
    const inputs = await queries.txInputs(txHash);
    const keyHex = keyFromProposeInputs(inputs);
    if (!keyHex) {
      throw new Error(
        `mpf reconstruct: no Before-datum input found in propose tx ${txHash}`,
      );
    }
    const ttl = await queries.txTtlSlot(txHash);
    const expiration = opts.slotToUnixMs(ttl) + opts.proposalLifetimeMs;
    leaves.push({ keyHex, valueHex: cborUint(expiration) });
  }
  return leaves;
};

/** Result of preparing a non-empty-trie insertion. */
export interface IMpfInsertion {
  /** On-chain `Proof` PlutusData (CBOR hex) for the state redeemer. */
  proofCborHex: string;
  /** The new MPF root after inserting (key, value), for the state datum. */
  newRootHex: string;
}

/**
 * Build the insertion proof + new root for adding (newKey, newValue) to the
 * trie described by `leaves`. Asserts the rebuilt root equals
 * `expectedCurrentRootHex` (integrity gate) before producing the proof.
 */
export const buildStateMpfInsertion = async (
  leaves: IMpfLeaf[],
  newKeyHex: string,
  newValueHex: string,
  expectedCurrentRootHex: string,
): Promise<IMpfInsertion> => {
  const { Trie } = await import("@aiken-lang/merkle-patricia-forestry");
  const trie = new Trie(); // in-memory store
  for (const leaf of leaves) {
    await trie.insert(
      Buffer.from(leaf.keyHex, "hex"),
      Buffer.from(leaf.valueHex, "hex"),
    );
  }
  // An empty trie has a null hash; it corresponds to the 32-zero-byte root.
  const rebuilt = trie.hash ? trie.hash.toString("hex") : "00".repeat(32);
  if (rebuilt !== expectedCurrentRootHex) {
    throw new Error(
      `mpf reconstruct: rebuilt root ${rebuilt} != on-chain root ` +
        `${expectedCurrentRootHex}; refusing to build a proof on an ` +
        `inconsistent trie (chain index incomplete or leaf derivation wrong)`,
    );
  }
  const newKey = Buffer.from(newKeyHex, "hex");
  const proof = await trie.prove(newKey, true); // exclusion proof for insertion
  const proofCborHex = proof.toCBOR().toString("hex");
  const after = await trie.insert(newKey, Buffer.from(newValueHex, "hex"));
  return { proofCborHex, newRootHex: after.hash.toString("hex") };
};
