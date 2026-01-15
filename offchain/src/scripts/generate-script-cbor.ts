/* eslint-disable no-console */
import { CosponsorState } from "@validators/CosponsorState.js";
import { Cosponsor } from "@validators/Cosponsor.js";
import {
  PROPOSAL_LIFETIME,
  PROTOCOL_BOOT_TRANSACTION_ID,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
} from "@/Config.js";

console.log("\n=== Generating Parameterized Script CBOR ===\n");

console.log("Parameters:");
console.log("  Boot Transaction ID:", PROTOCOL_BOOT_TRANSACTION_ID);
console.log("  Boot Transaction Index:", PROTOCOL_BOOT_TRANSACTION_INDEX);
console.log("  Proposal Lifetime:", PROPOSAL_LIFETIME, "ms\n");

// Generate the parameterized CosponsorState script
console.log("1. Generating CosponsorState script...");
const cosponsorState = new CosponsorState(
  PROTOCOL_BOOT_TRANSACTION_ID,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
  PROPOSAL_LIFETIME
);

const stateScript = cosponsorState.script();
const stateScriptHash = stateScript.hash();
console.log("   Hash:", stateScriptHash);

// Generate the parameterized Cosponsor script
console.log("\n2. Generating Cosponsor script...");
const cosponsor = Cosponsor.new({
  statePolicyId: stateScriptHash,
});

const cosponsorScript = cosponsor.script();
const cosponsorScriptCbor = cosponsorScript.toCbor();
const cosponsorScriptHash = cosponsorScript.hash();

console.log("   Hash:", cosponsorScriptHash);
console.log("   CBOR length:", cosponsorScriptCbor.length, "characters");

console.log("\n=== Output for BrowserConfig.ts ===\n");
console.log("Copy and paste this into cosponsor-ui/src/lib/cosponsor-sdk/BrowserConfig.ts:");
console.log("\n```typescript");
console.log("cosponsor: {");
console.log(`  hash: '${cosponsorScriptHash}',`);
console.log(`  name: 'Cosponsor (Parameterized)',`);
console.log(`  cbor: '${cosponsorScriptCbor}',`);
console.log("},");
console.log("```\n");

console.log("✅ Done! Make sure the hash matches what's in your deployed-contracts.json\n");
