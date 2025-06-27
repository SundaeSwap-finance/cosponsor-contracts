use aiken/cbor.{serialise}
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use aiken/fuzz.{constant}
use aiken/fuzz/scenario.{Scenario}
use aiken/interval.{Finite, Interval, IntervalBound}
use aiken/merkle_patricia_forestry.{Leaf, Proof}
use calculation/shared.{proposal_procedure_hash}
use cardano/address.{Address, Script}
use cardano/assets.{Value}
use cardano/fuzz as cardano
use cardano/governance.{GovernanceAction, ProposalProcedure}
use cardano/script_context.{ScriptContext}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, ScriptPurpose, Transaction,
  ValidityRange,
}
use cosponsor_state as handlers
use tests/shared.{
  anchor_fuzzer, cosponsor_state_output_with_cpp, cosponsor_state_validator_hash,
  proposal_lifetime, protocol_boot_utxo, scenario_proposal_procedure_baseline,
  scenario_validity_range,
} as tshared
use types/cosponsor.{Anchor, CosponsoredProposalProcedure}
use types/cosponsor_state.{CosponsorStateDatum,
  CosponsorStateRedeemer} as cosponsor_state_types

test prop_cosponsor_state_mint_ok(ok via scenario.ok(default_state(Mint), step)) {
  run_as(ok)
  list.for_each(ok, post_conditions)
}

test prop_cosponsor_state_mint_ko(
  (labels, ko) via scenario.ko(default_state(Mint), step),
) fail {
  list.for_each(list.unique(labels), fuzz.label)
  run_as(ko)
}

test prop_cosponsor_state_spend_ok(
  ok via scenario.ok(default_state(Spend), step),
) {
  run_as(ok)
  list.for_each(ok, post_conditions)
}

test prop_cosponsor_state_spend_ko(
  (labels, ko) via scenario.ko(default_state(Spend), step),
) fail {
  list.for_each(list.unique(labels), fuzz.label)
  run_as(ko)
}

fn post_conditions(scenario: Transaction) {
  let minted =
    scenario.mint
      |> assets.policies()
      |> list.has(cosponsor_state_validator_hash)

  []
    |> scenario.classify(@"· action = bootstrap", minted)
    |> scenario.classify(@"· action = spend", !minted)
    |> list.for_each(fuzz.label)
}

fn run_as(txs: List<Transaction>) {
  let default_handler =
    handlers.cosponsor_state.else(protocol_boot_utxo, proposal_lifetime, _)

  let spend_handler =
    fn(
      datum: Option<Data>,
      redeemer: Data,
      output_reference: OutputReference,
      transaction: Transaction,
    ) {
      expect r: CosponsorStateRedeemer = redeemer
      let d: Option<CosponsorStateDatum> =
        when datum is {
          Some(data) -> {
            expect some_d: CosponsorStateDatum = data
            Some(some_d)
          }
          None -> None
        }
      handlers.cosponsor_state.spend(
        protocol_boot_utxo,
        proposal_lifetime,
        d,
        r,
        output_reference,
        transaction,
      )
    }

  let mint_handler =
    handlers.cosponsor_state.mint(
      protocol_boot_utxo,
      proposal_lifetime,
      _,
      _,
      _,
    )

  scenario.run(
    txs,
    cosponsor_state_validator_hash,
    mint_handler,
    spend_handler,
    scenario.into_withdraw_handler(default_handler),
    scenario.into_publish_handler(default_handler),
    scenario.into_vote_handler(default_handler),
  )
}

type TransactionType {
  Mint
  Spend
}

type State {
  done: Bool,
  transaction_type: TransactionType,
  labels: List<String>,
}

fn default_state(transaction_type: TransactionType) -> State {
  State { done: False, transaction_type, labels: [] }
}

fn step(st: State) -> Fuzzer<Scenario<State>> {
  if st.done {
    constant(Scenario.Done)
  } else {
    let (st, inputs, output_ref) <-
      scenario.fork_and_then(
        128,
        fn() { scenario_inputs_baseline(st) },
        fn() { scenario_inputs_missing_boot_utxo(st) },
      )

    let validity_range <- fuzz.and_then(scenario_validity_range())

    expect Interval {
      upper_bound: IntervalBound {
        bound_type: Finite(validity_upper),
        is_inclusive: True,
      },
      ..
    } = validity_range

    let (st, cpp) <-
      fuzz.and_then(
        when st.transaction_type is {
          Mint -> fuzz.both(constant(st), constant(None))
          Spend -> {
            let pp <- fuzz.and_then(scenario_proposal_procedure_baseline())
            let anchor <- fuzz.and_then(anchor_fuzzer())
            let cpp = CosponsoredProposalProcedure { procedure: pp, anchor }
            fuzz.both(constant(st), constant(Some(cpp)))
          }
        },
      )

    let (st, proposal_procedures) <-
      fuzz.and_then(
        when st.transaction_type is {
          Mint -> fuzz.both(constant(st), constant([]))
          Spend -> {
            expect Some(cpp) = cpp
            scenario.fork(
              128,
              fn() { constant((st, [cpp.procedure])) },
              fn() {
                constant(
                  (
                    State {
                      ..st,
                      labels: [@"Missing proposal procedures", ..st.labels],
                    },
                    [],
                  ),
                )
              },
            )
          }
        },
      )

    let (st, redeemers) <-
      fuzz.and_then(scenario_redeemers_baseline(st, output_ref, cpp))

    let (st, mint) <- fuzz.and_then(scenario_mints(st))

    let (st, outputs) <-
      fuzz.and_then(scenario_outputs(st, cpp, validity_upper))

    constant(
      Scenario.Step(
        st.labels,
        State { ..st, done: True, labels: [] },
        Transaction {
          ..transaction.placeholder,
          mint: mint,
          inputs: inputs,
          outputs: outputs,
          redeemers: redeemers,
          proposal_procedures: proposal_procedures,
          validity_range: validity_range,
        },
      ),
    )
  }
}

fn scenario_spend_redeemer_baseline(
  st: State,
  cpp: CosponsoredProposalProcedure,
) -> Fuzzer<(State, CosponsorStateRedeemer)> {
  let proof = []
  let redeemer = CosponsorStateRedeemer { proof, anchor_list: [cpp.anchor] }
  fuzz.both(constant(st), constant(redeemer))
}

fn scenario_redeemers_baseline(
  st: State,
  output_ref: OutputReference,
  cpp: Option<CosponsoredProposalProcedure>,
) -> Fuzzer<(State, List<Pair<ScriptPurpose, Data>>)> {
  let (st, redeemer): (State, Pair<ScriptPurpose, Data>) <-
    fuzz.and_then(
      when st.transaction_type is {
        Mint ->
          fuzz.both(
            constant(st),
            constant(
              Pair(
                ScriptPurpose.Mint(cosponsor_state_validator_hash),
                as_data(Void),
              ),
            ),
          )
        Spend -> {
          expect Some(cpp) = cpp
          let (st, redeemer) <-
            fuzz.and_then(scenario_spend_redeemer_baseline(st, cpp))
          fuzz.both(
            constant(st),
            constant(Pair(ScriptPurpose.Spend(output_ref), as_data(redeemer))),
          )
        }
      },
    )

  let redeemers = [redeemer]

  fuzz.both(constant(st), constant(redeemers))
}

fn scenario_state_output_initial(st: State) -> Fuzzer<(State, Output)> {
  let output =
    Output {
      address: Address {
        payment_credential: Script(cosponsor_state_validator_hash),
        stake_credential: None,
      },
      value: assets.from_asset(
        cosponsor_state_validator_hash,
        cosponsor_state_types.cosponsor_state_nft_name,
        1,
      ),
      datum: InlineDatum(
        CosponsorStateDatum {
          expired_proposals_mpf_root: merkle_patricia_forestry.root(
            merkle_patricia_forestry.empty,
          ),
        },
      ),
      reference_script: None,
    }
  fuzz.both(constant(st), constant(output))
}

fn scenario_updated_state_output(
  st: State,
  cpp: CosponsoredProposalProcedure,
  validity_upper: Int,
) -> Fuzzer<(State, Output)> {
  let output = cosponsor_state_output_with_cpp(cpp, validity_upper)
  fuzz.both(constant(st), constant(output))
}

fn scenario_outputs(
  st: State,
  cpp: Option<CosponsoredProposalProcedure>,
  validity_upper: Int,
) -> Fuzzer<(State, List<Output>)> {
  let (st, state_output) <-
    fuzz.and_then(
      when st.transaction_type is {
        Mint ->
          scenario.fork(
            128,
            fn() { scenario_state_output_initial(st) },
            fn() {
              let output <- fuzz.and_then(cardano.output())
              fuzz.both(
                constant(
                  State { ..st, labels: [@"Missing state output", ..st.labels] },
                ),
                constant(output),
              )
            },
          )
        Spend -> {
          expect Some(cpp) = cpp
          scenario.fork(
            128,
            fn() { scenario_updated_state_output(st, cpp, validity_upper) },
            fn() {
              let (st, output) <-
                fuzz.and_then(scenario_state_output_initial(st))
              fuzz.both(
                constant(
                  State {
                    ..st,
                    labels: [@"Missing updated state output", ..st.labels],
                  },
                ),
                constant(output),
              )
            },
          )
        }
      },
    )
  fuzz.both(constant(st), constant([state_output]))
}

fn scenario_mints(st: State) -> Fuzzer<(State, Value)> {
  when st.transaction_type is {
    Mint ->
      fuzz.both(
        constant(st),
        constant(
          assets.from_asset(
            cosponsor_state_validator_hash,
            cosponsor_state_types.cosponsor_state_nft_name,
            1,
          ),
        ),
      )
    _ -> fuzz.both(constant(st), constant(assets.zero))
  }
}

fn scenario_inputs_baseline(
  st: State,
) -> Fuzzer<(State, List<Input>, OutputReference)> {
  let inputs <- fuzz.and_then(fuzz.list_between(cardano.input(), 1, 10))

  let relevant_utxo <-
    fuzz.and_then(
      when st.transaction_type is {
        Mint ->
          cardano.input_with(constant(protocol_boot_utxo), cardano.output())
        Spend -> {
          let (st, output) <- fuzz.and_then(scenario_state_output_initial(st))
          cardano.input_with(cardano.output_reference(), constant(output))
        }
      },
    )
  fuzz.tuple3(
    constant(st),
    constant([relevant_utxo, ..inputs]),
    constant(relevant_utxo.output_reference),
  )
}

fn scenario_inputs_missing_boot_utxo(
  st: State,
) -> Fuzzer<(State, List<Input>, OutputReference)> {
  let inputs <- fuzz.and_then(fuzz.list_between(cardano.input(), 1, 10))
  when st.transaction_type is {
    Mint ->
      fuzz.tuple3(
        constant(State { ..st, labels: [@"Missing boot utxo", ..st.labels] }),
        constant(inputs),
        cardano.output_reference(),
      )
    _ -> scenario_inputs_baseline(st)
  }
}
