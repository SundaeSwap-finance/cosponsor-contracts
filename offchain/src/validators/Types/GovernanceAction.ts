import { CosponsorTypes } from "../GeneratedTypes";
import { TCredential } from "./Credential";
export interface IGovernanceAction {
  kind: string;
}
export interface ITreasuryWithdrawal extends IGovernanceAction {
  kind: "TreasuryWithdrawal";
  beneficiaries: Map<TCredential, bigint>;
  guardRails?: string;
}

export interface INicePoll extends IGovernanceAction {
  kind: "NicePoll";
}

export type TGovernanceAction = ITreasuryWithdrawal | INicePoll;

export function ToContractType(
  ga: TGovernanceAction,
): CosponsorTypes.GovernanceAction {
  switch (ga.kind) {
    case "TreasuryWithdrawal": {
      const tw = ga as ITreasuryWithdrawal;
      return {
        TreasuryWithdrawal: {
          beneficiaries: Array.from(tw.beneficiaries).map(([k, v]) => {
            if ("vkey" in k) {
              return [{ VerificationKeyCredential: [k.vkey] }, v];
            } else {
              return [{ ScriptCredential: [k.script] }, v];
            }
          }),
          guardrails: tw.guardRails,
        },
      };
    }
    case "NicePoll": {
      return "NicePoll";
    }
  }
}
