import { parse } from "@blaze-cardano/data";
import { CosponsorTypes } from "@validators/GeneratedTypes";
import { ICosponsoredProposal } from "@validators/Cosponsor";
import { TGovernanceAction } from "@validators/Types/GovernanceAction";

export interface ParsedCosponsorDatum {
  proposal: ICosponsoredProposal;
  datumType: "Before" | "After";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawCosponsoredProposal?: any;
}

/**
 * Parse a CosponsorDatum from on-chain data
 * @param datumData - The raw datum data from the chain
 * @returns Parsed datum info or null if parsing fails
 */
export const parseCosponsorDatum = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  datumData: any,
): ParsedCosponsorDatum | null => {
  try {
    const datum = parse(CosponsorTypes.CosponsorDatum, datumData);

    if (datum && typeof datum === "object") {
      // Check if it's a "Before" datum with cosponsored proposal
      if ("Before" in datum && datum.Before && "cosponsored" in datum.Before) {
        const cosponsoredProposal = datum.Before.cosponsored;

        const proposal: ICosponsoredProposal = {
          deposit: cosponsoredProposal.procedure.deposit,
          anchor: {
            url: cosponsoredProposal.anchor.url,
            hash: cosponsoredProposal.anchor.hash,
          },
          action: cosponsoredProposal.procedure?.governanceAction || {
            kind: "Unknown",
          } as TGovernanceAction,
        };

        return {
          proposal,
          datumType: "Before",
          rawCosponsoredProposal: cosponsoredProposal,
        };
      }

      // Check if it's an "After" datum (proposal completed)
      if (datum === "After" || "After" in datum) {
        return {
          proposal: {
            deposit: 0n,
            anchor: { url: "completed", hash: "completed" },
            action: { kind: "Completed" } as TGovernanceAction,
          },
          datumType: "After",
        };
      }
    }

    return null;
  } catch {
    return null;
  }
};
