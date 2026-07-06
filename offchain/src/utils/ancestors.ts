/**
 * Prev-governance-action-id ("ancestor") resolution.
 *
 * Conway threads per-purpose state: NoConfidence/UpdateCommittee,
 * NewConstitution, ParameterChange and HardForkInitiation actions are REJECTED
 * (`InvalidPrevGovActionId`) unless they name the currently-enacted action of
 * their purpose — or `null` iff that purpose has NEVER been enacted on the
 * network. `null` is verified WRONG for the Committee purpose on preview
 * (burned a 1000-tADA deposit proving it — see PREVIEW-DEPOSITS-TO-RECLAIM.md),
 * so never guess: resolve at submission time.
 *
 * Source: Koios `/proposal_list` (public, no key). The ledger's
 * `prevGovActionIds` for a purpose is the LAST ENACTED action of that purpose,
 * which Koios exposes as `enacted_epoch`. Cross-checked against Koios
 * `/committee_info` for the Committee purpose (identical result on preview:
 * ac993231…#0, enacted epoch 1013).
 */

import type { IGovernanceActionId } from "@validators/Types/GovernanceAction.js";

/** The four Conway purposes that thread prev-gov-action-id state. */
export type TAncestorPurpose =
  | "Committee"
  | "Constitution"
  | "PParamUpdate"
  | "HardFork";

/** Koios `proposal_type` values belonging to each purpose. */
const PURPOSE_PROPOSAL_TYPES: Record<TAncestorPurpose, readonly string[]> = {
  Committee: ["NewCommittee", "NoConfidence"],
  Constitution: ["NewConstitution"],
  PParamUpdate: ["ParameterChange"],
  HardFork: ["HardForkInitiation"],
};

/** Which purpose (if any) an SDK governance-action kind threads. */
export const ANCESTOR_PURPOSE_BY_KIND: Record<
  string,
  TAncestorPurpose | undefined
> = {
  NoConfidence: "Committee",
  ConstitutionalCommittee: "Committee",
  NewConstitution: "Constitution",
  ProtocolParameters: "PParamUpdate",
  HardFork: "HardFork",
  // NicePoll (InfoAction) and TreasuryWithdrawal take no ancestor.
};

export interface IResolveAncestorOptions {
  /** Koios API base. Default: preview. Mainnet: https://api.koios.rest/api/v1 */
  koiosBaseUrl?: string;
  fetchFn?: typeof fetch;
}

const DEFAULT_KOIOS_PREVIEW = "https://preview.koios.rest/api/v1";

interface IKoiosProposal {
  proposal_tx_hash: string;
  proposal_index: number;
  proposal_type: string;
  enacted_epoch: number | null;
}

/**
 * Resolve the prev-gov-action-id for `purpose`: the enacted action of that
 * purpose with the highest `enacted_epoch`, or `null` if none was ever
 * enacted (the only case where the ledger accepts a null ancestor).
 */
export const resolveAncestor = async (
  purpose: TAncestorPurpose,
  options: IResolveAncestorOptions = {},
): Promise<IGovernanceActionId | null> => {
  const base = options.koiosBaseUrl ?? DEFAULT_KOIOS_PREVIEW;
  const fetchFn = options.fetchFn ?? fetch;
  const url =
    `${base}/proposal_list` +
    "?select=proposal_tx_hash,proposal_index,proposal_type,enacted_epoch" +
    "&enacted_epoch=not.is.null";
  const response = await fetchFn(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `resolveAncestor: Koios proposal_list failed (${response.status})`,
    );
  }
  const proposals = (await response.json()) as IKoiosProposal[];
  const types = PURPOSE_PROPOSAL_TYPES[purpose];
  let latest: IKoiosProposal | undefined;
  for (const proposal of proposals) {
    if (!types.includes(proposal.proposal_type)) continue;
    if (proposal.enacted_epoch === null) continue;
    if (!latest || proposal.enacted_epoch > latest.enacted_epoch!) {
      latest = proposal;
    }
  }
  if (!latest) return null;
  return { txHash: latest.proposal_tx_hash, index: latest.proposal_index };
};

/**
 * Guard for real submissions: the fixture's ancestor is FIXED (it is hashed
 * into the gADA token at deposit time), but the ledger checks it against LIVE
 * governance state at submission. If an enactment happened in between, the
 * submission burns the whole gov deposit. Returns the live ancestor for
 * comparison; callers must abort on mismatch.
 */
export const assertAncestorCurrent = async (
  kind: string,
  fixtureAncestor: IGovernanceActionId | null | undefined,
  options: IResolveAncestorOptions = {},
): Promise<void> => {
  const purpose = ANCESTOR_PURPOSE_BY_KIND[kind];
  if (!purpose) return; // kind threads no ancestor
  const live = await resolveAncestor(purpose, options);
  const same =
    (live === null && !fixtureAncestor) ||
    (live !== null &&
      !!fixtureAncestor &&
      live.txHash === fixtureAncestor.txHash &&
      BigInt(live.index) === BigInt(fixtureAncestor.index));
  if (!same) {
    const show = (a: IGovernanceActionId | null | undefined) =>
      a ? `${a.txHash}#${a.index}` : "null";
    throw new Error(
      `assertAncestorCurrent: ${kind} fixture ancestor ${show(fixtureAncestor)} ` +
        `!= live ${purpose} ancestor ${show(live)} — submitting would burn the ` +
        `gov deposit. Re-deposit with the live ancestor first.`,
    );
  }
};
