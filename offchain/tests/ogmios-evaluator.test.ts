/**
 * createOgmiosEvaluator helpers — additionalUtxo supplementation for tx
 * chaining (field bug 2026-06-12: chained tx inputs unknown to the Ogmios
 * node failed evaluation because the evaluator ignored its additionalUtxos
 * parameter entirely).
 */

import { describe, expect, test } from "bun:test";
import { Core } from "@blaze-cardano/sdk";
import {
  extractMissingUtxoRefs,
  serializeUtxoForOgmios,
} from "@/browser/blazeProvider.js";

const TX_ID =
  "2bee05d10a25d37de21b75961962580b579e3d3e983c353e2265e20d4f33f82e";
const WALLET_ADDR =
  "addr_test1qp69u6ka06zrxm0akqsfku6w862klmxx5gv8s2n5sv75nfxenku8xvgssv0852hyj36cpkzfs5p0pqpspt6qapm2rapqkayyvf";
const POLICY = "87264e48adc75c4472c4e52e80acd36051ca153f42ee339fb04f5a28";
const ASSET_NAME =
  "e45a9e584c38dce7f77c544b8a7d39c61331a435dbaf1d9e2340577a871817f4";

const makeUtxo = (
  coins: bigint,
  assets?: Map<Core.AssetId, bigint>,
): Core.TransactionUnspentOutput =>
  Core.TransactionUnspentOutput.fromCore([
    { txId: Core.TransactionId(TX_ID), index: 1 },
    {
      address: Core.PaymentAddress(WALLET_ADDR),
      value: { coins, ...(assets ? { assets } : {}) },
    },
  ]);

describe("extractMissingUtxoRefs", () => {
  test("pulls the txid#index out of a real Ogmios 3004 error payload", () => {
    const message =
      `Ogmios evaluation failed: {"code":3010,"message":"Some scripts of ` +
      `the transactions terminated with error(s).","data":[{"validator":` +
      `{"index":0,"purpose":"mint"},"error":{"code":3004,"message":"Unable ` +
      `to create the evaluation context from the given transaction.",` +
      `"data":{"reason":"Unknown transaction input (missing from UTxO ` +
      `set): ${TX_ID}#0"}}}]}`;
    expect(extractMissingUtxoRefs(message)).toEqual([`${TX_ID}#0`]);
  });

  test("dedupes repeated references and handles multiple", () => {
    const other = "a".repeat(64);
    const text = `${TX_ID}#0 ... ${TX_ID}#0 ... ${other}#13`;
    expect(extractMissingUtxoRefs(text)).toEqual([`${TX_ID}#0`, `${other}#13`]);
  });

  test("returns empty for unrelated errors", () => {
    expect(extractMissingUtxoRefs("validator returned false")).toEqual([]);
  });
});

describe("serializeUtxoForOgmios", () => {
  test("serializes a pure-ADA UTxO into the v6 additionalUtxo shape", () => {
    const entry = serializeUtxoForOgmios(makeUtxo(5_000_000n));
    expect(entry).toEqual({
      transaction: { id: TX_ID },
      index: 1,
      address: WALLET_ADDR,
      value: { ada: { lovelace: 5_000_000 } },
    });
  });

  test("serializes multi-asset values grouped by policy", () => {
    const assets = new Map<Core.AssetId, bigint>([
      [Core.AssetId(`${POLICY}${ASSET_NAME}`), 500_000_000n],
    ]);
    const entry = serializeUtxoForOgmios(makeUtxo(2_000_000n, assets));
    expect(entry.value).toEqual({
      ada: { lovelace: 2_000_000 },
      [POLICY]: { [ASSET_NAME]: 500_000_000 },
    });
  });

  test("throws on quantities beyond JSON-safe integers", () => {
    expect(() =>
      serializeUtxoForOgmios(makeUtxo(BigInt(Number.MAX_SAFE_INTEGER) + 1n)),
    ).toThrow(/JSON-safe/);
  });
});
