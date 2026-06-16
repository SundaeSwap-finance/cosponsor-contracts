/**
 * Audit C3 — `selectUtxosForWithdrawal` feeds `selectedUtxos[0]` in
 * BrowserWithdrawal. These tests lock its selection contract so the empty /
 * under-funded edge cases (which the explicit guard now protects against)
 * stay well-defined.
 *
 * The function only reads `lockedAmount`, so we pass minimal IScriptUtxo-shaped
 * stubs.
 */

import { describe, expect, test } from "bun:test";
import {
  selectUtxosForWithdrawal,
  type IScriptUtxo,
} from "@/browser/fetchUserDeposits.js";

const utxo = (lockedAmount: bigint, i: number): IScriptUtxo =>
  ({
    txHash: `tx${i}`,
    outputIndex: i,
    lockedAmount,
  }) as unknown as IScriptUtxo;

// Caller pre-sorts biggest-first; this stub mirrors that.
const sorted = [utxo(10_000_000n, 0), utxo(5_000_000n, 1), utxo(2_000_000n, 2)];

describe("selectUtxosForWithdrawal — expected behaviour", () => {
  test("a single UTxO covering the target stops after one", () => {
    const { selected, totalSelected } = selectUtxosForWithdrawal(
      sorted,
      8_000_000n,
    );
    expect(selected).toHaveLength(1);
    expect(totalSelected).toBe(10_000_000n);
  });

  test("accumulates in order until the target is covered", () => {
    const { selected, totalSelected } = selectUtxosForWithdrawal(
      sorted,
      12_000_000n,
    );
    expect(selected.map((u) => u.outputIndex)).toEqual([0, 1]);
    expect(totalSelected).toBe(15_000_000n);
  });

  test("exact match stops without pulling extra UTxOs", () => {
    const { selected, totalSelected } = selectUtxosForWithdrawal(
      sorted,
      10_000_000n,
    );
    expect(selected).toHaveLength(1);
    expect(totalSelected).toBe(10_000_000n);
  });
});

describe("selectUtxosForWithdrawal — edge / under-funded cases", () => {
  test("target exceeding the total returns everything with totalSelected < target", () => {
    // This is the case the upstream `totalSelected < withdrawAmount` throw catches.
    const { selected, totalSelected } = selectUtxosForWithdrawal(
      sorted,
      99_000_000n,
    );
    expect(selected).toHaveLength(3);
    expect(totalSelected).toBe(17_000_000n);
    expect(totalSelected).toBeLessThan(99_000_000n);
  });

  test("target of 0 selects nothing (selected[0] would be undefined — guarded path)", () => {
    const { selected, totalSelected } = selectUtxosForWithdrawal(sorted, 0n);
    expect(selected).toHaveLength(0);
    expect(totalSelected).toBe(0n);
  });

  test("empty input yields an empty, well-defined result", () => {
    const { selected, totalSelected } = selectUtxosForWithdrawal(
      [],
      1_000_000n,
    );
    expect(selected).toEqual([]);
    expect(totalSelected).toBe(0n);
  });
});
