/**
 * Unit tests for the pure parts of the Propose builder
 * (src/utils/proposeBuilder.ts): raw body-field extraction, the single-leaf
 * MPF root, the fixed-point runner (with synthetic redeemer bytes), leftover
 * math, and the anchor-URL convention bridge.
 *
 * No network calls — the fixture body is the SAME golden vector the Aiken
 * suite (validators/tests/propose_proof.ak) and propose-body-golden.test.ts
 * lock, so field extraction is pinned to the canonical layout.
 */
import { describe, expect, it } from "bun:test";
import { blake2b_256, HexBlob } from "@blaze-cardano/core";
import {
  anchorUrlHexToText,
  cborByteString,
  computeLeftover,
  extractBodyField,
  extractCollateralFieldHex,
  extractScriptDataHash,
  listBodyKeys,
  MIN_LEFTOVER_LOVELACE,
  mpfRootAfterFirstInsert,
  NULL_MPF_ROOT,
  runFixedPoint,
  skipCborItem,
} from "../src/utils/proposeBuilder.js";
import { cborUint } from "../src/utils/proposeBody.js";

// Fixture constants — identical to propose-body-golden.test.ts /
// validators/tests/propose_proof.ak.
const COSPONSOR_HASH =
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffdd";
const TRUE_POLICY = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffee";
const USER_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SIGNER_KEY = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TXID_COS =
  "1111111111111111111111111111111111111111111111111111111111111111";
const TXID_USER =
  "3333333333333333333333333333333333333333333333333333333333333333";
const TXID_COL =
  "5555555555555555555555555555555555555555555555555555555555555555";
const SDH = "4444444444444444444444444444444444444444444444444444444444444444";

// The Blaze-side body golden vector (11 fields, pre-splice).
const GOLDEN_BODY =
  "ab" +
  "00d9010282" +
  ("825820" + TXID_COS + "00") +
  ("825820" + TXID_USER + "00") +
  ("018182581d60" + USER_KEY + "1a004c4b40") +
  "021a00030d40" +
  "031903e8" +
  ("05a1581df0" + COSPONSOR_HASH + "00") +
  ("09a1581c" + TRUE_POLICY + "a15820" + SDH + "01") +
  ("0b5820" + SDH) +
  ("0dd9010281825820" + TXID_COL + "00") +
  ("0ed9010281581c" + SIGNER_KEY) +
  ("1082581d60" + USER_KEY + "1a001e8480") +
  "111a000f4240";

describe("CBOR body-field extraction", () => {
  it("lists the golden body's keys in serialized order", () => {
    expect(listBodyKeys(GOLDEN_BODY)).toEqual([
      0, 1, 2, 3, 5, 9, 11, 13, 14, 16, 17,
    ]);
  });

  it("extracts the raw collateral fields byte-for-byte", () => {
    const fields = extractCollateralFieldHex(GOLDEN_BODY);
    expect(fields.collateralInputs).toBe(
      "d9010281825820" + TXID_COL + "00",
    );
    expect(fields.collateralOutput).toBe(
      "82581d60" + USER_KEY + "1a001e8480",
    );
    expect(fields.collateralFee).toBe("1a000f4240");
  });

  it("extracts the script data hash without its bytestring header", () => {
    expect(extractScriptDataHash(GOLDEN_BODY)).toBe(SDH);
  });

  it("returns undefined for absent keys", () => {
    expect(extractBodyField(GOLDEN_BODY, 20)).toBeUndefined();
    expect(extractBodyField(GOLDEN_BODY, 4)).toBeUndefined();
  });

  it("skips nested tags, arrays, maps, and 64-bit uints correctly", () => {
    // d90102 tag → array of two items: a nested map and a 1b-headed uint.
    const item = "d9010282" + "a10203" + "1b000000e8d4a51000";
    expect(skipCborItem(item, 0)).toBe(item.length);
    // Extraction across a field whose value is that nested item.
    const body = "a3" + "00" + item + "01" + "182a" + "0f" + "f6";
    expect(extractBodyField(body, 0)).toBe(item);
    expect(extractBodyField(body, 1)).toBe("182a");
    expect(extractBodyField(body, 15)).toBe("f6");
  });

  it("refuses indefinite-length items and non-map bodies", () => {
    expect(() => skipCborItem("9f0102ff", 0)).toThrow(/additional info/);
    expect(() => listBodyKeys("820102")).toThrow(/not a CBOR map/);
  });

  it("errors with a pointer at collateral-return-less bodies", () => {
    // Same body with field 16 (collateral return) dropped: aa header, 10 keys.
    const withoutReturn = GOLDEN_BODY.replace(
      "1082581d60" + USER_KEY + "1a001e8480",
      "",
    ).replace(/^ab/, "aa");
    expect(() => extractCollateralFieldHex(withoutReturn)).toThrow(
      /collateral field/,
    );
  });
});

describe("cborByteString", () => {
  it("encodes short and 24+ byte strings", () => {
    expect(cborByteString("ff")).toBe("41ff");
    expect(cborByteString("00".repeat(23))).toBe("57" + "00".repeat(23));
    expect(cborByteString("00".repeat(24))).toBe("5818" + "00".repeat(24));
    expect(cborByteString("00".repeat(57))).toBe("5839" + "00".repeat(57));
  });

  it("rejects odd-length hex", () => {
    expect(() => cborByteString("abc")).toThrow(/odd-length/);
  });
});

describe("MPF single-leaf root (empty-trie first insert)", () => {
  const key = "aa".repeat(32); // proposal hash
  const value = cborUint(1_751_500_000_000n + 432_000_000n); // expiration ms

  it("matches the manual combine(suffix(path,0), blake2b(value)) composition", () => {
    // including(key, value, []) with cursor 0:
    //   suffix(path, 0) = 0xff || blake2b_256(key)
    //   root = blake2b_256(suffix || blake2b_256(value))
    const path = blake2b_256(HexBlob(key));
    const valueHash = blake2b_256(HexBlob(value));
    const expected = blake2b_256(HexBlob("ff" + path + valueHash));
    expect(mpfRootAfterFirstInsert(key, value)).toBe(expected);
  });

  it("is 32 bytes and sensitive to both key and value", () => {
    const root = mpfRootAfterFirstInsert(key, value);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
    expect(root).not.toBe(NULL_MPF_ROOT);
    expect(mpfRootAfterFirstInsert("bb".repeat(32), value)).not.toBe(root);
    expect(mpfRootAfterFirstInsert(key, cborUint(1n))).not.toBe(root);
  });
});

describe("fixed-point runner (synthetic sdh feedback)", () => {
  // Synthetic model of the builder loop: the "script data hash" is a pure
  // function of the redeemer bytes, which are a pure function of the
  // collateral bytes; collateral bytes freeze after the first observation.
  const realCollateral = "d9010281825820" + "12".repeat(32) + "01";
  const sdhOf = (collateral: string) =>
    blake2b_256(HexBlob(collateral)).slice(0, 64);

  it("converges: placeholder → real collateral → stable sdh", async () => {
    type TState = { collateral: string; sdh: string };
    const result = await runFixedPoint<TState, number>(
      { collateral: "d9010280", sdh: "00".repeat(32) },
      async (candidate, iteration) => ({
        // Collateral is frozen from the outside (like pinned collateral +
        // frozen fee); sdh is recomputed from the candidate's collateral.
        observed: { collateral: realCollateral, sdh: sdhOf(candidate.collateral) },
        artifact: iteration,
      }),
      (a, b) => a.collateral === b.collateral && a.sdh === b.sdh,
    );
    // Pass 1 observes real collateral + sdh(placeholder); pass 2 observes
    // sdh(real); pass 3 confirms the fixed point.
    expect(result.iterations).toBe(3);
    expect(result.value.sdh).toBe(sdhOf(realCollateral));
    expect(result.artifact).toBe(2);
  });

  it("throws when the sequence never stabilizes", async () => {
    let n = 0;
    await expect(
      runFixedPoint<number, null>(
        0,
        async () => ({ observed: ++n, artifact: null }),
        (a, b) => a === b,
        4,
      ),
    ).rejects.toThrow(/no convergence after 4/);
  });
});

describe("leftover math", () => {
  it("returns the exact surplus", () => {
    expect(computeLeftover(150_000_000n, 100_000_000n)).toBe(50_000_000n);
    expect(computeLeftover(100_000_000n, 100_000_000n)).toBe(0n);
  });

  it("throws when the pool cannot fund the deposit", () => {
    expect(() => computeLeftover(99_999_999n, 100_000_000n)).toThrow(
      /do not cover/,
    );
  });

  it("throws on positive-but-dust leftovers (exact preservation rule)", () => {
    expect(() =>
      computeLeftover(100_000_001n, 100_000_000n),
    ).toThrow(/below the minimum/);
    expect(
      computeLeftover(100_000_000n + MIN_LEFTOVER_LOVELACE, 100_000_000n),
    ).toBe(MIN_LEFTOVER_LOVELACE);
  });
});

describe("anchor URL convention bridge", () => {
  it("round-trips the hex datum convention to text losslessly", () => {
    const url = "https://governance.cardano.org/test-proposal-2.json";
    const hex = Buffer.from(url, "utf8").toString("hex");
    expect(anchorUrlHexToText(hex)).toBe(url);
    expect(anchorUrlHexToText(hex.toUpperCase())).toBe(url);
  });

  it("rejects URL bytes that are not valid UTF-8", () => {
    expect(() => anchorUrlHexToText("ff00")).toThrow(/not valid UTF-8/);
  });
});
