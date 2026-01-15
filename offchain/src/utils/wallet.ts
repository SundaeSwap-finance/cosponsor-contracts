import { HotWallet, Provider } from "@blaze-cardano/sdk";
import { Bip32PrivateKey } from "@blaze-cardano/core";
import { mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const createWallet = async (
  seedPhrase: string,
  provider: Provider,
  expectedAddress?: string,
  debugMode?: boolean,
): Promise<HotWallet> => {
  const entropy = mnemonicToEntropy(seedPhrase, wordlist);
  const rootKey = Bip32PrivateKey.fromBip39Entropy(
    Buffer.from(entropy) as any,
    Buffer.from("") as any,
  );
  const wallet = await HotWallet.fromMasterkey(rootKey.hex() as any, provider);

  const address = await wallet.getChangeAddress();
  const addressStr = address.toBech32();

  if (expectedAddress && addressStr !== expectedAddress) {
    throw new Error(
      `Address mismatch! Expected ${expectedAddress}, got ${addressStr}`,
    );
  }

  if (debugMode) {
    console.log(`✓ Wallet initialized: ${addressStr}`);
  }
  return wallet;
};

export const createWalletFromPrivateKey = async (
  privateKey: string,
  provider: Provider,
  expectedAddress?: string,
  debugMode?: boolean,
): Promise<HotWallet> => {
  const wallet = await HotWallet.fromMasterkey(privateKey as any, provider);

  const address = await wallet.getChangeAddress();
  const addressStr = address.toBech32();

  if (expectedAddress && addressStr !== expectedAddress) {
    throw new Error(
      `Address mismatch! Expected ${expectedAddress}, got ${addressStr}`,
    );
  }

  if (debugMode) {
    console.log(`✓ Wallet initialized: ${addressStr}`);
  }
  return wallet;
};
