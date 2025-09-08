import { HotWallet }          from '@blaze-cardano/sdk'
import {
  Bip32PrivateKey,
  NetworkId
}                             from '@blaze-cardano/core'
import { mnemonicToEntropy }  from '@scure/bip39'
import { wordlist }           from '@scure/bip39/wordlists/english'

// This file can be used to verify the expected address is generated
const EXPECTED_ADDRESS = ""

export const createWallet = async (seedPhrase: string): Promise<HotWallet> => {
  const entropy = mnemonicToEntropy(seedPhrase, wordlist)
  const rootKey = Bip32PrivateKey.fromBip39Entropy(Buffer.from(entropy), Buffer.from(""))
  const wallet = await HotWallet.fromMasterkey(rootKey.hex(), NetworkId.Testnet)
  
  const address = await wallet.getChangeAddress()
  const addressStr = address.toBech32()
  
  if (addressStr !== EXPECTED_ADDRESS) {
    throw new Error(`Address mismatch! Expected ${EXPECTED_ADDRESS}, got ${addressStr}`)
  }
  
  console.log(`✓ Wallet initialized: ${addressStr}`)
  return wallet
}
