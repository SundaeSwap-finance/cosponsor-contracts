use aiken/cbor.{serialise}
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{Lovelace, Value}
use cardano/transaction.{
  Datum, DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference,
}
use types/cosponsor.{CosponsoredProposalProcedure}

pub fn convert_inputs(inputs: List<Input>) -> ByteArray {
  let (length, bytes) =
    list.foldr(
      inputs,
      (0, ""),
      fn(input, acc) {
        let OutputReference { transaction_id: hash, output_index: index } =
          input.output_reference

        (
          acc.1st + 1,
          bytearray.concat(#"82", hash)
            |> bytearray.concat(serialise(index))
            |> bytearray.concat(acc.2nd),
        )
      },
    )

  if length <= 23 {
    bytearray.from_int_big_endian(128 + length, 1) |> bytearray.concat(bytes)
  } else {
    bytearray.concat(#"9f", bytes) |> bytearray.concat(#"ff")
  }
}

pub fn convert_mint(mint: Value) -> ByteArray {
  mint |> serialise
}

pub fn convert_outputs(outputs: List<Output>) -> ByteArray {
  let (length, bytes) =
    list.foldr(
      outputs,
      (0, ""),
      fn(output, acc) {
        let Output { address, value, datum, .. } = output

        let (add_datum, datum_bytes) = convert_datum(datum)
        (
          acc.1st + 1,
          bytearray.from_int_big_endian(130 + add_datum, 1)
            |> bytearray.concat(convert_address(address))
            |> bytearray.concat(convert_value(value))
            |> bytearray.concat(datum_bytes)
            |> bytearray.concat(acc.2nd),
        )
      },
    )

  if length <= 23 {
    bytearray.from_int_big_endian(128 + length, 1) |> bytearray.concat(bytes)
  } else {
    bytearray.concat(#"9f", bytes) |> bytearray.concat(#"ff")
  }
}

pub fn convert_fee(fee: Lovelace) -> ByteArray {
  fee |> serialise
}

pub fn convert_extra_signatories(signatures: List<ByteArray>) -> ByteArray {
  let (length, bytes) =
    list.foldr(
      signatures,
      (0, ""),
      fn(signature, acc) {
        (acc.1st + 1, bytearray.concat(serialise(signature), acc.2nd))
      },
    )
  if length <= 23 {
    bytearray.from_int_big_endian(128 + length, 1) |> bytearray.concat(bytes)
  } else {
    bytearray.concat(#"9f", bytes) |> bytearray.concat(#"ff")
  }
}

fn convert_datum(datum: Datum) -> (Int, ByteArray) {
  when datum is {
    NoDatum -> (0, "")
    DatumHash(datum_hash) -> (1, datum_hash)
    InlineDatum(datum_bytes) -> (1, serialise(datum_bytes))
  }
}

fn convert_value(assets: Value) -> ByteArray {
  let lovelace = assets.lovelace_of(assets) |> serialise
  let multi_asset = assets.without_lovelace(assets) |> serialise

  if multi_asset == #"a0" {
    lovelace
  } else {
    #"82" |> bytearray.concat(lovelace) |> bytearray.concat(multi_asset)
  }
}

fn convert_address(address: Address) -> ByteArray {
  //; bit 4: payment cred is keyhash/scripthash
  let (header_byte_pc, credential_p) =
    when address.payment_credential is {
      Script(cred) -> (16, cred)
      VerificationKey(cred) -> (0, cred)
    }
  let (header_byte_sc, credential_s) =
    when address.stake_credential is {
      None -> (96, "")
      Some(Inline(VerificationKey(cred))) -> (0, cred)
      Some(Inline(Script(cred))) -> (32, cred)
      _ -> fail @"no way"
    }
  bytearray.from_int_big_endian(header_byte_pc + header_byte_sc, 1)
    |> bytearray.concat(bytearray.concat(credential_p, credential_s))
    |> serialise
}

pub fn convert_proposals(
  proposals: List<CosponsoredProposalProcedure>,
) -> ByteArray {
  let (length, bytes) =
    list.foldr(
      proposals,
      (0, ""),
      fn(proposal, acc) {
        (acc.1st + 1, bytearray.concat(convert_proposal(proposal), acc.2nd))
      },
    )
  if length <= 23 {
    bytearray.from_int_big_endian(128 + length, 1) |> bytearray.concat(bytes)
  } else {
    bytearray.concat(#"9f", bytes) |> bytearray.concat(#"ff")
  }
}

fn convert_proposal(proposal: CosponsoredProposalProcedure) -> ByteArray {
  #"84"
    |> bytearray.concat(serialise(proposal.procedure.deposit))
    |> bytearray.concat(serialise(proposal.procedure.return_address))
    |> bytearray.concat(serialise(proposal.procedure.governance_action))
    |> bytearray.concat(serialise(proposal.anchor))
}
