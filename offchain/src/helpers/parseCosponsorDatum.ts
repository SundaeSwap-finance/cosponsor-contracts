import { parse } from "@blaze-cardano/data";
import { Core } from "@blaze-cardano/sdk";
import { CosponsorTypes } from "@validators/GeneratedTypes";
import { ICosponsoredProposal } from "@validators/Cosponsor";
import { fromContractType } from "@validators/Types/GovernanceAction";

export interface ParsedCosponsorDatum {
  proposal: ICosponsoredProposal;
  datumType: "Before" | "After";
  /**
   * The raw parsed inner `cosponsored` object, kept as `unknown` because its
   * shape is tied to generated validator types that can drift independently.
   * Downstream callers that need to re-serialize (e.g. to compute the gADA
   * asset name) should pass this through `serialize(CosponsorTypes.CosponsoredProposalProcedure, rawCosponsoredProposal)`
   * directly — that avoids the lossy round-trip through `fromContractType`
   * for the Pairs-typed fields (TreasuryWithdrawal beneficiaries,
   * ConstitutionalCommittee addedMembers).
   */
  rawCosponsoredProposal?: unknown;
}

/**
 * Discriminated result of a CosponsorDatum parse.
 *
 * Pre-audit code returned `ParsedCosponsorDatum | null` and swallowed every
 * error to `null` — see AUDIT.md F9. Callers couldn't distinguish "no
 * datum", "datum is in unexpected shape", and "schema regression made
 * parse() throw on a perfectly valid on-chain datum" (which was the trigger
 * for Bug 2's downstream fallback). The discriminated shape makes the three
 * states explicit and forces the caller to choose a policy.
 */
export type ParseCosponsorDatumResult =
  | { ok: true; value: ParsedCosponsorDatum }
  | { ok: false; reason: "parse-threw" | "unexpected-shape"; error?: unknown };

/**
 * Parse a CosponsorDatum from on-chain data.
 *
 * Returns:
 * - `{ ok: true, value }` — successfully parsed as `Before` or `After`.
 * - `{ ok: false, reason: "parse-threw", error }` — `@blaze-cardano/data`'s
 *   `parse()` threw, likely a schema mismatch. Treat the UTxO as opaque.
 * - `{ ok: false, reason: "unexpected-shape" }` — `parse()` returned a
 *   value but its shape didn't match any expected CosponsorDatum variant.
 *
 * The literal-string `"After"` check is performed BEFORE the
 * `typeof === "object"` guard so the After case is reachable — the old code
 * placed it inside the guard, making `datum === "After"` unreachable
 * (AUDIT.md F11).
 */
export const parseCosponsorDatum = (
  datumData: Core.PlutusData,
): ParseCosponsorDatumResult => {
  let datum: ReturnType<typeof parse<typeof CosponsorTypes.CosponsorDatum>>;
  try {
    datum = parse(CosponsorTypes.CosponsorDatum, datumData);
  } catch (error) {
    return { ok: false, reason: "parse-threw", error };
  }

  if (datum === "After") {
    return {
      ok: true,
      value: {
        proposal: {
          deposit: 0n,
          anchor: { url: "", hash: "" },
          action: { kind: "NicePoll" },
        },
        datumType: "After",
      },
    };
  }

  if (typeof datum !== "object" || datum === null) {
    return { ok: false, reason: "unexpected-shape" };
  }

  if ("Before" in datum && datum.Before && "cosponsored" in datum.Before) {
    const cosponsored = datum.Before.cosponsored;
    const govAction = cosponsored.procedure?.governanceAction;
    if (!govAction) {
      return { ok: false, reason: "unexpected-shape" };
    }
    return {
      ok: true,
      value: {
        proposal: {
          deposit: cosponsored.procedure.deposit,
          anchor: {
            url: cosponsored.anchor.url,
            hash: cosponsored.anchor.hash,
          },
          action: fromContractType(govAction),
        },
        datumType: "Before",
        rawCosponsoredProposal: cosponsored,
      },
    };
  }

  return { ok: false, reason: "unexpected-shape" };
};
