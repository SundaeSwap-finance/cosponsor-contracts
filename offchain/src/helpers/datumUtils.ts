import { Core } from "@blaze-cardano/sdk";

/**
 * Minimal structural view of a UTxO datum. Typed structurally (not as
 * `Core.Datum`) on purpose: the concrete `Datum` nominal type diverges between
 * the transitively-imported `@blaze-cardano/core` and `@cardano-sdk/core`
 * packages, and only the former actually carries `kind()`/`asInlineData()` at
 * the type level even though the runtime object always does. Accepting the
 * structural shape lets every call site pass its own `Datum` without a cast.
 */
interface InlineDatumLike {
  kind?: () => number;
  asInlineData?: () => unknown;
}

/**
 * Extract the inline `PlutusData` from a UTxO datum, or `null` when there is
 * nothing inline to decode (datum absent, datum-hash only, or an impl that
 * doesn't expose `kind()`/`asInlineData()`).
 *
 * Standardises the three slightly-divergent inline-datum checks that used to
 * live in `depositIndexer`, `fetch-submissions`, and `fetchUserDeposits`
 * (audit H3). The last of those coerced the raw datum object into `PlutusData`
 * on a hash-only datum (`datum.asInlineData?.() ?? datum`); returning `null`
 * here makes "no inline data" explicit so callers decide the fallback.
 */
export const extractInlineDatum = (
  datum: InlineDatumLike | null | undefined,
): Core.PlutusData | null => {
  if (!datum) return null;
  if (typeof datum.kind !== "function") return null;
  if (datum.kind() !== 1) return null; // 1 = inline datum; 0 = datum hash
  const inline = datum.asInlineData?.();
  return (inline ?? null) as Core.PlutusData | null;
};
