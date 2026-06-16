/**
 * Audit H7 — pendingUtxoTracker now sweeps entries older than `ttlMs` so a
 * long-running SPA session can't accumulate dead tracking state indefinitely.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { pendingUtxoTracker, PENDING_TTL_MS } from "@/browser/utxoTracker.js";

afterEach(() => {
  pendingUtxoTracker.ttlMs = PENDING_TTL_MS;
  pendingUtxoTracker.clearAll();
});

describe("pendingUtxoTracker TTL (audit H7)", () => {
  test("default TTL is 10 minutes", () => {
    expect(PENDING_TTL_MS).toBe(10 * 60 * 1000);
  });

  test("entries older than ttlMs are swept on the next apply", () => {
    pendingUtxoTracker.clearAll();
    pendingUtxoTracker.recordTransaction(
      "aa".repeat(32),
      [{ txHash: "bb".repeat(32), outputIndex: 0 }],
      [],
    );
    expect(pendingUtxoTracker.getStats().spentCount).toBe(1);

    // Make every existing entry count as expired (cutoff in the future).
    pendingUtxoTracker.ttlMs = -1;
    pendingUtxoTracker.applyToUtxoList([]);
    expect(pendingUtxoTracker.getStats().spentCount).toBe(0);
  });

  test("fresh entries survive a sweep within TTL", () => {
    pendingUtxoTracker.clearAll();
    pendingUtxoTracker.ttlMs = PENDING_TTL_MS;
    pendingUtxoTracker.recordTransaction(
      "cc".repeat(32),
      [{ txHash: "dd".repeat(32), outputIndex: 1 }],
      [],
    );
    pendingUtxoTracker.applyToUtxoList([]);
    expect(pendingUtxoTracker.getStats().spentCount).toBe(1);
  });
});

describe("pendingUtxoTracker.clearTransaction", () => {
  test("clears the spent entries recorded by the given submitted tx", () => {
    pendingUtxoTracker.clearAll();
    const submittedTxHash = "11".repeat(32);
    pendingUtxoTracker.recordTransaction(
      submittedTxHash,
      [{ txHash: "22".repeat(32), outputIndex: 0 }],
      [],
    );
    expect(pendingUtxoTracker.getStats().spentCount).toBe(1);

    pendingUtxoTracker.clearTransaction(submittedTxHash);
    expect(pendingUtxoTracker.getStats().spentCount).toBe(0);
  });

  test("leaves entries from other submitted txs untouched", () => {
    pendingUtxoTracker.clearAll();
    pendingUtxoTracker.recordTransaction(
      "33".repeat(32),
      [{ txHash: "44".repeat(32), outputIndex: 0 }],
      [],
    );
    pendingUtxoTracker.recordTransaction(
      "55".repeat(32),
      [{ txHash: "66".repeat(32), outputIndex: 0 }],
      [],
    );
    expect(pendingUtxoTracker.getStats().spentCount).toBe(2);

    // Clearing one submitted tx must not drop the other's spent entry.
    pendingUtxoTracker.clearTransaction("33".repeat(32));
    expect(pendingUtxoTracker.getStats().spentCount).toBe(1);
  });
});
