import dotenv from "dotenv";
import {
  Blaze,
  Blockfrost,
  Kupmios,
  HotWallet,
  Provider,
} from "@blaze-cardano/sdk";
import { MIN_PROVIDER_BALANCE } from "@/Config";
import { Unwrapped } from "@blaze-cardano/ogmios";
import {
  Bip32PrivateKey,
  Bip32PrivateKeyHex,
  NetworkId,
  Address,
} from "@blaze-cardano/core";
import { mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { logger } from "../logger.js";
dotenv.config();

export interface BlockfrostConfig {
  type: "blockfrost";
  blockfrostKey: string;
  network?: "cardano-preview" | "cardano-preprod" | "cardano-mainnet";
  debugMode?: boolean;
  wallet: {
    seedPhrase?: string;
    privateKey?: string;
    expectedAddress?: string;
    expectedBalance?: bigint;
  };
}

export interface KupmiosConfig {
  type: "kupmios";
  ogmiosUrl: string;
  kupoUrl: string;
  debugMode?: boolean;
  wallet: {
    seedPhrase?: string;
    privateKey?: string;
    expectedAddress?: string;
    expectedBalance?: bigint;
  };
}

export type ProviderConfig = BlockfrostConfig | KupmiosConfig;

export class CardanoProvider {
  private provider!: Provider;
  private wallet!: HotWallet;
  private blaze!: Blaze<Provider, HotWallet>;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  private log(...args: unknown[]): void {
    if (this.config.debugMode) {
      logger.debug(...args);
    }
  }

  static async fromEnv(): Promise<CardanoProvider> {
    const config = CardanoProvider.parseEnvConfig();
    const provider = new CardanoProvider(config);
    await provider.initialize();
    return provider;
  }

  private static parseEnvConfig(): ProviderConfig {
    // Determine provider type based on environment variables
    const hasBlockfrost = !!process.env.BLOCKFROST_API_KEY;
    const hasKupmios = !!(process.env.KUPO_URL && process.env.OGMIOS_URL);

    if (!hasBlockfrost && !hasKupmios) {
      throw new Error(
        "No provider configuration found. Set either BLOCKFROST_API_KEY or both KUPO_URL and OGMIOS_URL",
      );
    }

    const wallet = {
      seedPhrase: process.env.WALLET_SEED_PHRASE,
      privateKey: process.env.WALLET_PRIVATE_KEY,
      expectedAddress: process.env.WALLET_ADDRESS,
      expectedBalance: process.env.EXPECTED_BALANCE_ADA
        ? BigInt(Number(process.env.EXPECTED_BALANCE_ADA) * 1_000_000)
        : undefined,
    };

    const debugMode =
      process.env.DEBUG_MODE === "true" || process.env.DEBUG_MODE === "1";

    // Default to Blockfrost if both are available
    if (hasBlockfrost) {
      return {
        type: "blockfrost",
        blockfrostKey: process.env.BLOCKFROST_API_KEY!,
        network: "cardano-preview",
        debugMode,
        wallet,
      };
    } else {
      return {
        type: "kupmios",
        ogmiosUrl: process.env.OGMIOS_URL!,
        kupoUrl: process.env.KUPO_URL!,
        debugMode,
        wallet,
      };
    }
  }

  private async initializeProvider(): Promise<Provider> {
    this.log(`Initializing ${this.config.type} provider...`);

    if (this.config.type === "blockfrost") {
      const network = this.config.network || "cardano-preview";
      this.log(`Using Blockfrost for ${network}`);
      return new Blockfrost({
        network,
        projectId: this.config.blockfrostKey,
      });
    } else if (this.config.type === "kupmios") {
      this.log(`Kupo URL: ${this.config.kupoUrl}`);
      this.log(`Ogmios URL: ${this.config.ogmiosUrl}`);
      this.log("Connecting to Ogmios...");

      const ogmios = await Unwrapped.Ogmios.new(this.config.ogmiosUrl);
      return new Kupmios(this.config.kupoUrl, ogmios);
    } else {
      // Exhaustive check: if a new config type is added, TypeScript will surface it here.
      const _exhaustive: never = this.config;
      throw new Error(
        `Invalid provider configuration: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }

  private async initializeWallet(): Promise<HotWallet> {
    this.log("Initializing wallet...");

    if (!this.config.wallet.seedPhrase && !this.config.wallet.privateKey) {
      throw new Error(
        "Either WALLET_SEED_PHRASE or WALLET_PRIVATE_KEY environment variable is required",
      );
    }

    let wallet: HotWallet;

    if (this.config.wallet.seedPhrase) {
      this.log("Using seed phrase from environment");
      const entropy = mnemonicToEntropy(
        this.config.wallet.seedPhrase,
        wordlist,
      );
      const rootKey = Bip32PrivateKey.fromBip39Entropy(Buffer.from(entropy), "");
      wallet = await HotWallet.fromMasterkey(rootKey.hex(), this.provider);
    } else if (this.config.wallet.privateKey) {
      this.log("Using private key from environment");
      wallet = await HotWallet.fromMasterkey(
        Bip32PrivateKeyHex(this.config.wallet.privateKey),
        this.provider,
      );
    } else {
      throw new Error("No wallet configuration found");
    }

    // Blaze's HotWallet keeps a reference to its provider internally; no extra wiring needed.

    return wallet;
  }

  private async validateWalletAddress(): Promise<void> {
    const address = await this.wallet.getChangeAddress();
    const addressStr = address.toBech32();

    this.log(`Wallet address: ${addressStr}`);

    if (this.config.wallet.expectedAddress) {
      if (addressStr === this.config.wallet.expectedAddress) {
        this.log("Address matches expected address");
      } else {
        this.log(
          `Warning: Address does not match expected: ${this.config.wallet.expectedAddress}`,
        );
        this.log(
          "This may indicate a different seed phrase or derivation path",
        );
      }
    }
  }

  private async validateWalletBalance(): Promise<void> {
    this.log("Checking wallet balance...");

    try {
      const utxos = await this.wallet.getUnspentOutputs();
      const totalBalance = utxos.reduce(
        (acc, utxo) => acc + utxo.output().amount().coin(),
        0n,
      );
      const balanceAda = Number(totalBalance) / 1_000_000;

      this.log(`Found ${utxos.length} UTxOs`);
      this.log(`Total balance: ${balanceAda.toFixed(6)} ADA`);

      if (this.config.wallet.expectedBalance) {
        const expectedAda =
          Number(this.config.wallet.expectedBalance) / 1_000_000;
        const minExpected = expectedAda * 0.9; // Allow 10% tolerance

        if (balanceAda >= minExpected) {
          this.log(`Balance sufficient (expected ~${expectedAda} ADA)`);
        } else {
          this.log(
            `Warning: Balance may be low (expected ~${expectedAda} ADA)`,
          );
        }
      }

      if (totalBalance < MIN_PROVIDER_BALANCE) {
        this.log("Warning: Low balance may affect deployment");
      }
    } catch (error) {
      this.log(`Error: Could not fetch wallet balance: ${error}`);
      throw new Error(`Wallet balance validation failed: ${error}`);
    }
  }

  async initialize(): Promise<void> {
    this.log("Initializing Cardano Provider");
    this.log("================================");

    // Initialize provider
    this.provider = await this.initializeProvider();

    // Initialize wallet
    this.wallet = await this.initializeWallet();

    // Validate wallet address
    await this.validateWalletAddress();

    // Validate wallet balance
    await this.validateWalletBalance();

    // Create Blaze instance
    this.log("Creating Blaze instance...");
    try {
      this.blaze = (await Promise.race([
        Blaze.from(this.provider, this.wallet),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Blaze creation timeout")), 15000),
        ),
      ])) as Blaze<Provider, HotWallet>;

      this.log("Blaze instance created successfully");

      // Force sync UTxOs to ensure fresh state
      this.log("Syncing wallet UTxOs...");
      await this.wallet.getUnspentOutputs();
      this.log("UTxOs synced");
    } catch (error) {
      logger.error("Error creating Blaze instance:", error);
      throw error;
    }
  }

  getBlaze(): Blaze<Provider, HotWallet> {
    if (!this.blaze) {
      throw new Error("Provider not initialized. Call initialize() first.");
    }
    return this.blaze;
  }

  getProvider(): Provider {
    if (!this.provider) {
      throw new Error("Provider not initialized. Call initialize() first.");
    }
    return this.provider;
  }

  getWallet(): HotWallet {
    if (!this.wallet) {
      throw new Error("Wallet not initialized. Call initialize() first.");
    }
    return this.wallet;
  }

  async getWalletAddress(): Promise<Address> {
    if (!this.wallet) {
      throw new Error("Wallet not initialized. Call initialize() first.");
    }
    return await this.wallet.getChangeAddress();
  }

  async getWalletBalance(): Promise<{
    utxos: number;
    balance: bigint;
    balanceAda: number;
  }> {
    if (!this.wallet) {
      throw new Error("Wallet not initialized. Call initialize() first.");
    }

    const utxos = await this.wallet.getUnspentOutputs();
    const balance = utxos.reduce(
      (acc, utxo) => acc + utxo.output().amount().coin(),
      0n,
    );
    const balanceAda = Number(balance) / 1_000_000;

    return {
      utxos: utxos.length,
      balance,
      balanceAda,
    };
  }

  async cleanup(): Promise<void> {
    // Close the Ogmios websocket when using Kupmios.
    if (this.config.type === "kupmios" && this.provider instanceof Kupmios) {
      this.log("Closing Ogmios connection...");
      await this.provider.ogmios.kill();
    }
  }
}
