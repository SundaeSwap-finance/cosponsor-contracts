import dotenv from "dotenv"
dotenv.config()

console.log("Environment test:")
console.log("WALLET_SEED_PHRASE exists:", !!process.env.WALLET_SEED_PHRASE)
console.log("KUPO_URL:", process.env.KUPO_URL)
console.log("OGMIOS_URL:", process.env.OGMIOS_URL)

setTimeout(() => {
  console.log("Script completed")
  process.exit(0)
}, 1000)
