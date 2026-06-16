/**
 * Audit C1 — `groupClassifiedSubmissions` must never fabricate a synthetic
 * `unknown_<txid>` proposal group out of decode failures. Decode failures and
 * structural-validation failures are surfaced as `malformed` and skipped.
 *
 * The function is pure (no provider), so we feed it `IClassifiedSubmission`
 * values directly and assert the routing + stats.
 */

import { describe, expect, test } from "bun:test";
import type { ICosponsoredProposal } from "@/validators/Cosponsor.js";
import {
  groupClassifiedSubmissions,
  type IClassifiedSubmission,
} from "@/helpers/fetch-submissions.js";

const proposal = (deposit: bigint): ICosponsoredProposal =>
  ({
    deposit,
    anchor: {
      url: Buffer.from("https://example.com/p.json").toString("hex"),
      hash: "0".repeat(64),
    },
    action: { kind: "NicePoll" },
  }) as ICosponsoredProposal;

const validItem = (
  txHash: string,
  outputIndex: number,
  proposalHash: string,
  adaAmount: bigint,
  datumType: "Before" | "After" = "Before",
): IClassifiedSubmission => ({
  txHash,
  outputIndex,
  adaAmount,
  address: "addr_test1validdeposit",
  rawDatum: { tag: "raw" },
  decode: { ok: true, proposalHash, proposal: proposal(adaAmount), datumType },
  validation: { isValid: true },
});

const decodeFailedItem = (
  txHash: string,
  outputIndex: number,
  adaAmount: bigint,
  reason = "datum decode failed: unexpected-shape",
): IClassifiedSubmission => ({
  txHash,
  outputIndex,
  adaAmount,
  address: "addr_test1malformed",
  rawDatum: null,
  decode: { ok: false, reason },
  validation: { isValid: true },
});

describe("groupClassifiedSubmissions — valid grouping (expected behaviour)", () => {
  test("submissions with the same proposalHash collapse into one group", () => {
    const result = groupClassifiedSubmissions([
      validItem("aaaa1111", 0, "hashA", 10_000_000n),
      validItem("bbbb2222", 0, "hashA", 5_000_000n),
    ]);

    const groups = Object.keys(result.validSubmissions);
    expect(groups).toEqual(["hashA"]);
    const group = result.validSubmissions["hashA"];
    expect(group.submissionCount).toBe(2);
    expect(group.totalAda).toBe(15_000_000n);
    expect(group.status).toBe("Active");
    expect(result.malformedSubmissions).toHaveLength(0);
  });

  test("distinct proposalHashes stay in separate groups; After → Completed", () => {
    const result = groupClassifiedSubmissions([
      validItem("aaaa1111", 0, "hashA", 10_000_000n, "Before"),
      validItem("cccc3333", 0, "hashB", 7_000_000n, "After"),
    ]);

    expect(Object.keys(result.validSubmissions).sort()).toEqual([
      "hashA",
      "hashB",
    ]);
    expect(result.validSubmissions["hashA"].status).toBe("Active");
    expect(result.validSubmissions["hashB"].status).toBe("Completed");
  });
});

describe("groupClassifiedSubmissions — decode failures (audit C1 regression)", () => {
  test("a decode failure becomes a malformed entry, never a group", () => {
    const result = groupClassifiedSubmissions([
      decodeFailedItem("deadbeef", 0, 4_000_000n),
    ]);

    expect(Object.keys(result.validSubmissions)).toHaveLength(0);
    expect(result.malformedSubmissions).toHaveLength(1);
    expect(result.malformedSubmissions[0]).toMatchObject({
      txHash: "deadbeef",
      outputIndex: 0,
      adaAmount: 4_000_000n,
      reason: "datum decode failed: unexpected-shape",
    });
  });

  test("two decode failures from the SAME tx do NOT collide into one synthetic group", () => {
    // Pre-fix, both keyed under `unknown_${txid.slice(0,8)}` → one fake group.
    const result = groupClassifiedSubmissions([
      decodeFailedItem("samehash", 0, 1_000_000n),
      decodeFailedItem("samehash", 1, 2_000_000n),
    ]);

    expect(Object.keys(result.validSubmissions)).toHaveLength(0);
    expect(result.malformedSubmissions).toHaveLength(2);
    expect(result.malformedSubmissions.map((m) => m.outputIndex)).toEqual([
      0, 1,
    ]);
  });

  test("structural-validation failure (decode ok, UTxO spent) → malformed", () => {
    const item: IClassifiedSubmission = {
      ...validItem("eeee4444", 0, "hashA", 3_000_000n),
      validation: { isValid: false, reason: "Script UTxO already spent" },
    };
    const result = groupClassifiedSubmissions([item]);

    expect(Object.keys(result.validSubmissions)).toHaveLength(0);
    expect(result.malformedSubmissions[0].reason).toBe(
      "Script UTxO already spent",
    );
  });
});

describe("groupClassifiedSubmissions — stats over a mixed batch", () => {
  test("totals partition cleanly into valid vs malformed", () => {
    const result = groupClassifiedSubmissions([
      validItem("aaaa1111", 0, "hashA", 10_000_000n),
      validItem("bbbb2222", 0, "hashA", 5_000_000n),
      decodeFailedItem("deadbeef", 0, 4_000_000n),
      {
        ...validItem("eeee4444", 0, "hashB", 3_000_000n),
        validation: { isValid: false, reason: "spent" },
      },
    ]);

    expect(result.totalStats).toEqual({
      totalUTxOs: 4,
      validUTxOs: 2,
      malformedUTxOs: 2,
      totalAda: 22_000_000n,
      validAda: 15_000_000n,
      malformedAda: 7_000_000n,
    });
  });

  test("empty input yields empty, well-formed result", () => {
    const result = groupClassifiedSubmissions([]);
    expect(result.validSubmissions).toEqual({});
    expect(result.malformedSubmissions).toEqual([]);
    expect(result.totalStats.totalUTxOs).toBe(0);
    expect(result.totalStats.totalAda).toBe(0n);
  });
});
