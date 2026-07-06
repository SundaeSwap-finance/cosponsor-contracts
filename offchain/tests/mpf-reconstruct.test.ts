/**
 * Unit tests for the multi-entry MPF insertion logic
 * (src/utils/mpfReconstruct.ts :: buildStateMpfInsertion).
 *
 * Network-free: the leaves and roots below are the REAL Deployment #2 preview
 * vectors that the on-chain `cosponsor_state` validator accepted —
 *   leaf 1 (first InfoAction):  key ab663b88…  value cbor(exp1)
 *     → single-leaf root 5cad3508…  (state root after propose 4c02db33)
 *   leaf 2 (second InfoAction): key fc36a457…  value cbor(exp2)
 *     → two-leaf root  e30b8dbe…    (state root after propose 277badab)
 * so this pins the proof/root computation to bytes a live validator verified.
 */
import { describe, expect, it } from "bun:test";
import { buildStateMpfInsertion } from "../src/utils/mpfReconstruct.js";

const LEAF1 = {
  keyHex: "ab663b883c6bf45cf160820c656172ace2623d85a4912df89effc8e58f1dc837",
  valueHex: "1b0000019f474b0658",
};
const LEAF2_KEY =
  "fc36a457231f2cf9f289f4965fecf18b77c752b6b058ac1d79fa302e466558e8";
const LEAF2_VALUE = "1b0000019f4d490190";
const ROOT_AFTER_LEAF1 =
  "5cad350810d7e8a5e7374788f76748955ad9c7e3e296fb4be2c003f7d3393525";
const ROOT_AFTER_LEAF2 =
  "e30b8dbe638543e71b8ee1e1768a3bd065f2b0fc48483a841f2a6258b2885b9e";

describe("buildStateMpfInsertion (multi-entry MPF)", () => {
  it("inserts a 2nd leaf into a 1-leaf trie and yields the on-chain root", async () => {
    const { proofCborHex, newRootHex } = await buildStateMpfInsertion(
      [LEAF1],
      LEAF2_KEY,
      LEAF2_VALUE,
      ROOT_AFTER_LEAF1,
    );
    // Root after insertion must equal what the live validator accepted.
    expect(newRootHex).toBe(ROOT_AFTER_LEAF2);
    // Proof is the on-chain `Proof` list encoding (starts with a CBOR array).
    expect(proofCborHex.startsWith("9f")).toBe(true);
    expect(proofCborHex.length).toBeGreaterThan(2);
  });

  it("throws when the rebuilt root disagrees with the expected on-chain root", async () => {
    // Wrong expected root (leaf set inconsistent with claim) → must refuse.
    await expect(
      buildStateMpfInsertion([LEAF1], LEAF2_KEY, LEAF2_VALUE, "00".repeat(32)),
    ).rejects.toThrow(/rebuilt root/);
  });

  it("first insert into an empty trie matches the single-leaf formula", async () => {
    const { newRootHex } = await buildStateMpfInsertion(
      [],
      LEAF1.keyHex,
      LEAF1.valueHex,
      "00".repeat(32), // empty trie root
    );
    expect(newRootHex).toBe(ROOT_AFTER_LEAF1);
  });
});
