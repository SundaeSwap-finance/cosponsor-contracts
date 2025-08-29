use aiken/collection/list
use aiken/fuzz.{constant}
use aiken/fuzz/scenario.{Scenario}
use calculation/shared.{proposal_procedure_hash}
use cardano/address.{Address, Credential, Script}
use cardano/assets.{Lovelace, PolicyId, Value}
use cardano/fuzz as cardano
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, ScriptPurpose, Transaction,
}
use cosponsor as handlers
use tests/shared.{
  anchor_fuzzer, cosponsor_state_output_with_cpp, cosponsor_validator_hash,
  scenario_proposal_procedure_baseline, scenario_validity_range, state_nft,
  state_policy_id, true_policy_id,
} as tshared
use types/cosponsor.{
  CosponsorDatum, CosponsorMintRedeemer, CosponsorRedeemer,
  CosponsorWithdrawRedeemer, CosponsoredProposalProcedure,
}

//TODO: Test redeeming with expired proposal tokens from another expired proposal utxo
//TODO: Test redeeming before proposal expiration from an After utxo

test prop_cosponsor_deposit_ok(ok via scenario.ok(default_state(Deposit), step)) {
  run_as(ok)
  list.for_each(ok, post_conditions)
}

test prop_cosponsor_aggregate_ok(
  ok via scenario.ok(default_state(Aggregate), step),
) {
  run_as(ok)
  list.for_each(ok, post_conditions)
}

test prop_cosponsor_redeem_ok(ok via scenario.ok(default_state(Redeem), step)) {
  run_as(ok)
  list.for_each(ok, post_conditions)
}

fn post_conditions(scenario: Transaction) {
  let minted =
    scenario.mint |> assets.policies() |> list.has(cosponsor_validator_hash)
  let has_proposals = ( scenario.proposal_procedures |> list.length() ) > 0

  let in_inputs =
    (
      scenario.inputs
        |> list.filter(
            fn(input) {
              input.output.address.payment_credential == Script(
                cosponsor_validator_hash,
              )
            },
          )
        |> list.length()
    ) > 0

  []
    |> scenario.classify(@"· action = Propose", has_proposals)
    |> scenario.classify(@"· action = Aggregate", !minted && !has_proposals)
    |> scenario.classify(
        @"· action = Redeem",
        minted && !has_proposals && in_inputs,
      )
    |> scenario.classify(
        @"· action = Deposit",
        minted && !has_proposals && !in_inputs,
      )
    |> list.for_each(fuzz.label)
}

fn run_as(txs: List<Transaction>) {
  let default_handler =
    handlers.cosponsor.else(state_policy_id, state_nft, true_policy_id, _)

  let mint_handler =
    fn(redeemer: Data, own_policy_id: PolicyId, transaction: Transaction) {
      expect redeemer: CosponsorMintRedeemer = redeemer
      handlers.cosponsor.mint(
        state_policy_id,
        state_nft,
        true_policy_id,
        redeemer,
        own_policy_id,
        transaction,
      )
    }

  let spend_handler =
    handlers.cosponsor.spend(
      state_policy_id,
      state_nft,
      true_policy_id,
      _,
      _,
      _,
      _,
    )

  let withdraw_handler =
    fn(redeemer: Data, account: Credential, self: Transaction) {
      expect redeemer: CosponsorWithdrawRedeemer = redeemer
      handlers.cosponsor.withdraw(
        state_policy_id,
        state_nft,
        true_policy_id,
        redeemer,
        account,
        self,
      )
    }

  scenario.run(
    txs,
    cosponsor_validator_hash,
    mint_handler,
    spend_handler,
    withdraw_handler,
    scenario.into_publish_handler(default_handler),
    scenario.into_vote_handler(default_handler),
  )
}

type TransactionType {
  Deposit
  Redeem
  Propose
  Aggregate
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
    let cpp <- fuzz.and_then(cosponsored_proposal_procedure())

    let (st, inputs) <- fuzz.and_then(scenario_inputs(st, cpp))

    let validity_range <- fuzz.and_then(scenario_validity_range())

    let (st, reference_inputs) <-
      fuzz.and_then(scenario_reference_inputs(st, cpp))

    // expect Interval {
    //   upper_bound: IntervalBound {
    //     bound_type: Finite(validity_upper),
    //     is_inclusive: True,
    //   },
    //   ..
    // } = validity_range
    // let (st, proposal_procedures) <-
    //   fuzz.and_then(
    //     when st.transaction_type is {
    //       Mint -> fuzz.both(constant(st), constant([]))
    //       Spend -> {
    //         expect Some(cpp) = cpp
    //         scenario.fork(
    //           128,
    //           fn() { constant((st, [cpp.procedure])) },
    //           fn() {
    //             constant(
    //               (
    //                 State {
    //                   ..st,
    //                   labels: [@"Missing proposal procedures", ..st.labels],
    //                 },
    //                 [],
    //               ),
    //             )
    //           },
    //         )
    //       }
    //     },
    //   )
    let (st, redeemers) <-
      fuzz.and_then(
        scenario_redeemers_baseline(
          st,
          list.map(inputs, fn(i) { i.output_reference }),
        ),
      )

    let ada_in_inputs = cosponsor_ada_in_outputs(inputs)

    let (st, mint) <- fuzz.and_then(scenario_mints(st, cpp, ada_in_inputs))

    let expected_output_amount =
      when st.transaction_type is {
        Deposit ->
          assets.quantity_of(
            mint,
            cosponsor_validator_hash,
            proposal_procedure_hash(cpp),
          )
        Aggregate -> ada_in_inputs
        Redeem ->
          ada_in_inputs + assets.quantity_of(
            mint,
            cosponsor_validator_hash,
            proposal_procedure_hash(cpp),
          )
        Propose -> 0
      }

    let withdrawals =
      when st.transaction_type is {
        Deposit | Redeem | Propose -> []
        Aggregate -> [Pair(Script(cosponsor_validator_hash), 0)]
      }

    let (st, outputs) <-
      fuzz.and_then(scenario_outputs(st, cpp, expected_output_amount))

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
          proposal_procedures: [],
          validity_range: validity_range,
          withdrawals: withdrawals,
          reference_inputs: reference_inputs,
        },
      ),
    )
  }
}

fn scenario_reference_inputs(
  st: State,
  cpp: CosponsoredProposalProcedure,
) -> Fuzzer<(State, List<Input>)> {
  when st.transaction_type is {
    Redeem -> {
      let input <-
        fuzz.and_then(
          cardano.input_with(
            cardano.output_reference(),
            constant(cosponsor_state_output_with_cpp(cpp, 0)),
          ),
        )
      constant((st, [input]))
    }
    _ -> constant((st, []))
  }
}

fn cosponsor_ada_in_outputs(inputs: List<Input>) -> Int {
  inputs
    |> list.filter(
        fn(input) {
          input.output.address.payment_credential == Script(
            cosponsor_validator_hash,
          )
        },
      )
    |> list.foldl(
        0,
        fn(input, acc) { acc + assets.lovelace_of(input.output.value) },
      )
}

fn scenario_random_inputs() -> Fuzzer<List<Input>> {
  fuzz.list_between(cardano.input(), 1, 10)
}

fn scenario_inputs(
  st: State,
  cpp: CosponsoredProposalProcedure,
) -> Fuzzer<(State, List<Input>)> {
  when st.transaction_type is {
    Deposit -> fuzz.both(constant(st), scenario_random_inputs())
    Aggregate | Redeem ->
      fuzz.both(
        constant(st),
        fuzz.list_between(
          fuzz.map2(
            fuzz.int_at_least(1),
            cardano.output_reference(),
            fn(i, output_ref) {
              Input {
                output_reference: output_ref,
                output: cosponsor_output(Some(cpp), i),
              }
            },
          ),
          2,
          10,
        ),
      )
    _ -> fail @"Unsupported transaction type in scenario_inputs"
  }
}

fn cosponsor_output(
  cpp: Option<CosponsoredProposalProcedure>,
  lovelace: Lovelace,
) -> Output {
  let datum =
    when cpp is {
      Some(cpp) -> InlineDatum(CosponsorDatum.Before { cosponsored: cpp })
      None -> InlineDatum(CosponsorDatum.After)
    }
  Output {
    address: Address {
      payment_credential: Script(cosponsor_validator_hash),
      stake_credential: None,
    },
    value: assets.from_lovelace(lovelace),
    datum,
    reference_script: None,
  }
}

fn cosponsored_proposal_procedure() -> Fuzzer<CosponsoredProposalProcedure> {
  fuzz.map2(
    scenario_proposal_procedure_baseline(),
    anchor_fuzzer(),
    fn(pp, anchor) { CosponsoredProposalProcedure { procedure: pp, anchor } },
  )
}

fn scenario_outputs(
  st: State,
  cpp: CosponsoredProposalProcedure,
  amount: Int,
) -> Fuzzer<(State, List<Output>)> {
  when st.transaction_type is {
    Deposit | Aggregate | Redeem ->
      if amount > 0 {
        constant((st, [cosponsor_output(Some(cpp), amount)]))
      } else {
        constant((st, []))
      }
    _ -> fail @"Unsupported transaction type in scenario_outputs"
  }
}

fn scenario_mints(
  st: State,
  cpp: CosponsoredProposalProcedure,
  max_redeem: Int,
) -> Fuzzer<(State, Value)> {
  when st.transaction_type is {
    Deposit -> {
      let amount <- fuzz.and_then(fuzz.int_at_least(1))
      let token_name = proposal_procedure_hash(cpp)
      let mint = assets.from_asset(cosponsor_validator_hash, token_name, amount)
      constant((st, mint))
    }
    Aggregate -> constant((st, assets.zero))
    Redeem -> {
      let token_name = proposal_procedure_hash(cpp)
      let amount <- fuzz.and_then(fuzz.int_between(max_redeem, max_redeem))
      let mint =
        assets.from_asset(cosponsor_validator_hash, token_name, amount * -1)
      constant((st, mint))
    }
    _ -> fail @"Unsupported transaction type in scenario_mints"
  }
}

fn scenario_mint_redeemer(st: State) -> Fuzzer<(State, CosponsorMintRedeemer)> {
  when st.transaction_type is {
    Deposit -> constant((st, CosponsorMintRedeemer.MDeposit))
    _ -> fail @"Unsupported transaction type in scenario_mint_redeemer"
  }
}

fn saggregate_redeemers(
  output_references: List<OutputReference>,
) -> Pairs<ScriptPurpose, Data> {
  output_references
    |> list.map(
        fn(output_ref) {
          Pair(
            ScriptPurpose.Spend(output_ref),
            as_data(CosponsorRedeemer.SAggregate),
          )
        },
      )
}

fn scenario_redeemers_baseline(
  st: State,
  output_references: List<OutputReference>,
) -> Fuzzer<(State, Pairs<ScriptPurpose, Data>)> {
  when st.transaction_type is {
    Deposit -> {
      let (st, redeemer) <- fuzz.and_then(scenario_mint_redeemer(st))
      constant(
        (
          st,
          [
            Pair(
              ScriptPurpose.Mint(cosponsor_validator_hash),
              as_data(redeemer),
            ),
          ],
        ),
      )
    }
    Aggregate ->
      constant(
        (
          st,
          list.concat(
            saggregate_redeemers(output_references),
            [
              Pair(
                ScriptPurpose.Withdraw(Script(cosponsor_validator_hash)),
                as_data(CosponsorWithdrawRedeemer.WAggregate),
              ),
            ],
          ),
        ),
      )
    Redeem ->
      constant(
        (
          st,
          list.concat(
            saggregate_redeemers(output_references),
            [
              Pair(
                ScriptPurpose.Mint(cosponsor_validator_hash),
                as_data(
                  CosponsorMintRedeemer.MRedeem {
                    proof: [],
                    expired_proposals: [],
                  },
                ),
              ),
            ],
          ),
        ),
      )
    _ -> fail @"Unsupported transaction type in scenario_redeemers_baseline"
  }
}
