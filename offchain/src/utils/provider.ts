import dotenv                 from 'dotenv'
import {
  Blaze,
  Blockfrost,
  Kupmios,
  HotWallet,
  Provider
}                             from '@blaze-cardano/sdk'
import { Unwrapped }          from '@blaze-cardano/ogmios'
import {
  Bip32PrivateKey,
  NetworkId,
  Address
}                             from '@blaze-cardano/core'
import { mnemonicToEntropy }  from '@scure/bip39'
import { wordlist }           from '@scure/bip39/wordlists/english'

dotenv.config()

export interface ProviderConfig {
  type: 'blockfrost' | 'kupmios'
  blockfrost?: {
    projectId: string
    network: 'cardano-preview' | 'cardano-preprod' | 'cardano-mainnet'
  }
  kupmios?: {
    kupoUrl: string
    ogmiosUrl: string
  }
  wallet: {
    seedPhrase?: string
    privateKey?: string
    expectedAddress?: string
    expectedBalance?: bigint
  }
}

export class CardanoProvider {
  private provider: Provider
  private wallet: HotWallet
  private blaze: Blaze<any, HotWallet>
  private config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
  }

  static async fromEnv(): Promise<CardanoProvider> {
    const config = CardanoProvider.parseEnvConfig()
    const provider = new CardanoProvider(config)
    await provider.initialize()
    return provider
  }

  private static parseEnvConfig(): ProviderConfig {
    // Determine provider type based on environment variables
    const hasBlockfrost = !!process.env.BLOCKFROST_API_KEY
    const hasKupmios = !!(process.env.KUPO_URL && process.env.OGMIOS_URL)

    if (!hasBlockfrost && !hasKupmios) {
      throw new Error("No provider configuration found. Set either BLOCKFROST_API_KEY or both KUPO_URL and OGMIOS_URL")
    }

    // Default to Blockfrost if both are available
    const providerType = hasBlockfrost ? 'blockfrost' : 'kupmios'

    const config: ProviderConfig = {
      type: providerType as 'blockfrost' | 'kupmios',
      wallet: {
        seedPhrase: process.env.WALLET_SEED_PHRASE,
        privateKey: process.env.WALLET_PRIVATE_KEY,
        expectedAddress: process.env.WALLET_ADDRESS,
        expectedBalance: process.env.EXPECTED_BALANCE_ADA ? BigInt(Number(process.env.EXPECTED_BALANCE_ADA) * 1_000_000) : undefined
      }
    }

    if (providerType === 'blockfrost' && hasBlockfrost) {
      config.blockfrost = {
        projectId: process.env.BLOCKFROST_API_KEY!,
        network: 'cardano-preview'
      }
    }

    if (providerType === 'kupmios' && hasKupmios) {
      config.kupmios = {
        kupoUrl: process.env.KUPO_URL!,
        ogmiosUrl: process.env.OGMIOS_URL!
      }
    }

    return config
  }

  private async initializeProvider(): Promise<Provider> {
    console.log(`Initializing ${this.config.type} provider...`)

    if (this.config.type === 'blockfrost' && this.config.blockfrost) {
      console.log(`Using Blockfrost for ${this.config.blockfrost.network}`)
      return new Blockfrost({
        network: this.config.blockfrost.network,
        projectId: this.config.blockfrost.projectId,
      })
    } else if (this.config.type === 'kupmios' && this.config.kupmios) {
      console.log(`Kupo URL: ${this.config.kupmios.kupoUrl}`)
      console.log(`Ogmios URL: ${this.config.kupmios.ogmiosUrl}`)
      console.log("Connecting to Ogmios...")
      
      const ogmios = await Unwrapped.Ogmios.new(this.config.kupmios.ogmiosUrl)
      return new Kupmios(this.config.kupmios.kupoUrl, ogmios)
    } else {
      throw new Error(`Invalid provider configuration for type: ${this.config.type}`)
    }
  }

  private async initializeWallet(): Promise<HotWallet> {
    console.log("Initializing wallet...")

    if (!this.config.wallet.seedPhrase && !this.config.wallet.privateKey) {
      throw new Error("Either WALLET_SEED_PHRASE or WALLET_PRIVATE_KEY environment variable is required")
    }

    let wallet: HotWallet

    if (this.config.wallet.seedPhrase) {
      console.log("Using seed phrase from environment")
      const entropy = mnemonicToEntropy(this.config.wallet.seedPhrase, wordlist)
      const rootKey = Bip32PrivateKey.fromBip39Entropy(Buffer.from(entropy), Buffer.from(""))
      wallet = await HotWallet.fromMasterkey(rootKey.hex(), NetworkId.Testnet)
    } else if (this.config.wallet.privateKey) {
      console.log("Using private key from environment")
      wallet = await HotWallet.fromMasterkey(this.config.wallet.privateKey, NetworkId.Testnet)
    } else {
      throw new Error("No wallet configuration found")
    }

    // Set provider on wallet (required for some operations)
    (wallet as any).provider = this.provider

    return wallet
  }

  private async validateWalletAddress(): Promise<void> {
    const address = await this.wallet.getChangeAddress()
    const addressStr = address.toBech32()
    
    console.log(`Wallet address: ${addressStr}`)
    
    if (this.config.wallet.expectedAddress) {
      if (addressStr === this.config.wallet.expectedAddress) {
        console.log("Address matches expected address")
      } else {
        console.log(`Warning: Address does not match expected: ${this.config.wallet.expectedAddress}`)
        console.log("This may indicate a different seed phrase or derivation path")
      }
    }
  }

  private async validateWalletBalance(): Promise<void> {
    console.log("Checking wallet balance...")
    
    try {
      const utxos = await this.wallet.getUnspentOutputs()
      const totalBalance = utxos.reduce((acc, utxo) => acc + utxo.output().amount().coin(), 0n)
      const balanceAda = Number(totalBalance) / 1_000_000
      
      console.log(`Found ${utxos.length} UTxOs`)
      console.log(`Total balance: ${balanceAda.toFixed(6)} ADA`)
      
      if (this.config.wallet.expectedBalance) {
        const expectedAda = Number(this.config.wallet.expectedBalance) / 1_000_000
        const minExpected = expectedAda * 0.9 // Allow 10% tolerance
        
        if (balanceAda >= minExpected) {
          console.log(`Balance sufficient (expected ~${expectedAda} ADA)`)
        } else {
          console.log(`Warning: Balance may be low (expected ~${expectedAda} ADA)`)
        }
      }

      if (totalBalance < 5_000_000n) { // Less than 5 ADA
        console.log("Warning: Low balance may affect deployment")
      }

    } catch (error) {
      console.log(`Error: Could not fetch wallet balance: ${error}`)
      throw new Error(`Wallet balance validation failed: ${error}`)
    }
  }

  async initialize(): Promise<void> {
    console.log("Initializing Cardano Provider")
    console.log("================================")

    // Initialize provider
    this.provider = await this.initializeProvider()
    
    // Initialize wallet
    this.wallet = await this.initializeWallet()
    
    // Validate wallet address
    await this.validateWalletAddress()
    
    // Validate wallet balance
    await this.validateWalletBalance()
    
    // Create Blaze instance
    console.log("Creating Blaze instance...")
    try {
      this.blaze = await Promise.race([
        Blaze.from(this.provider, this.wallet),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Blaze creation timeout")), 15000)
        )
      ]) as Blaze<any, HotWallet>
      
      console.log("Blaze instance created successfully")
      
      // Force sync UTxOs to ensure fresh state
      console.log("Syncing wallet UTxOs...")
      await this.wallet.getUnspentOutputs()
      console.log("UTxOs synced")
      
    } catch (error) {
      console.error("Error creating Blaze instance:", error)
      throw error
    }
  }

  getBlaze(): Blaze<any, HotWallet> {
    if (!this.blaze) {
      throw new Error("Provider not initialized. Call initialize() first.")
    }
    return this.blaze
  }

  getProvider(): Provider {
    if (!this.provider) {
      throw new Error("Provider not initialized. Call initialize() first.")
    }
    return this.provider
  }

  getWallet(): HotWallet {
    if (!this.wallet) {
      throw new Error("Wallet not initialized. Call initialize() first.")
    }
    return this.wallet
  }

  async getWalletAddress(): Promise<Address> {
    if (!this.wallet) {
      throw new Error("Wallet not initialized. Call initialize() first.")
    }
    return await this.wallet.getChangeAddress()
  }

  async getWalletBalance(): Promise<{ utxos: number; balance: bigint; balanceAda: number }> {
    if (!this.wallet) {
      throw new Error("Wallet not initialized. Call initialize() first.")
    }
    
    const utxos = await this.wallet.getUnspentOutputs()
    const balance = utxos.reduce((acc, utxo) => acc + utxo.output().amount().coin(), 0n)
    const balanceAda = Number(balance) / 1_000_000
    
    return {
      utxos: utxos.length,
      balance,
      balanceAda
    }
  }

  async cleanup(): Promise<void> {
    // Close connections if available
    if (this.config.type === 'kupmios' && (this.provider as any).ogmios?.shutdown) {
      console.log("Closing Ogmios connection...")
      await (this.provider as any).ogmios.shutdown()
    }
  }
}
