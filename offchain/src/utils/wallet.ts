import { HotWallet, Provider } from "@blaze-cardano/sdk";
import { Bip32PrivateKey, Bip32PrivateKeyHex } from "@blaze-cardano/core";
import { mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { logger } from "../logger.js";
export const createWallet = async (
  seedPhrase: string,
  provider: Provider,
  expectedAddress?: string,
  debugMode?: boolean,
): Promise<HotWallet> => {
  const entropy = mnemonicToEntropy(seedPhrase, wordlist);
  const rootKey = Bip32PrivateKey.fromBip39Entropy(Buffer.from(entropy), "");
  const wallet = await HotWallet.fromMasterkey(rootKey.hex(), provider);

  const address = await wallet.getChangeAddress();
  const addressStr = address.toBech32();

  if (expectedAddress && addressStr !== expectedAddress) {
    throw new Error(
      `Address mismatch! Expected ${expectedAddress}, got ${addressStr}`,
    );
  }

  if (debugMode) {
    logger.debug(`✓ Wallet initialized: ${addressStr}`);
  }
  return wallet;
};

export const createWalletFromPrivateKey = async (
  privateKey: string,
  provider: Provider,
  expectedAddress?: string,
  debugMode?: boolean,
): Promise<HotWallet> => {
  const wallet = await HotWallet.fromMasterkey(
    Bip32PrivateKeyHex(privateKey),
    provider,
  );

  const address = await wallet.getChangeAddress();
  const addressStr = address.toBech32();

  if (expectedAddress && addressStr !== expectedAddress) {
    throw new Error(
      `Address mismatch! Expected ${expectedAddress}, got ${addressStr}`,
    );
  }

  if (debugMode) {
    logger.debug(`✓ Wallet initialized: ${addressStr}`);
  }
  return wallet;
};
