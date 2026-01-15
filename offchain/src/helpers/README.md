# Helper Scripts

This directory contains utility and debugging scripts for the cosponsor protocol.

## Available Helpers

### `inspect-deposit.ts`
Debug tool to inspect deposit transactions and verify their structure.

**Usage:**
```bash
bun run inspect-deposit <transaction_hash>
```

**Example:**
```bash
bun run inspect-deposit 1c2e5fb35c535483243d6b3b01bc04a121c59b6ec599a776032c88cd75fca27b
```

Shows:
- Script UTxO details (ADA deposited)
- gAda token amounts and verification
- Asset policy IDs and names
- Transaction output structure

### `checkEnvVars.ts`
Validates that all required environment variables are properly configured.

**Usage:**
```bash
bun run check-env
```

Verifies:
- Wallet seed phrase
- Provider endpoints
- Network configuration

### `fetch-submissions.ts`
Fetches all current on-chain deposit submissions and groups them by proposal.

**Usage:**
```bash
bun run fetch-submissions
```

Shows:
- All UTxOs at the cosponsor script address
- ADA amounts deposited per submission
- Submissions grouped by proposal (when datum parsing is enhanced)
- Total ADA deposited across all proposals
- Summary statistics

**Example Output:**
```
📋 Proposal: unknown
   Submissions: 9
   Total ADA: 70 ADA (70000000 lovelace)
     • 10 ADA - a38702c2...53ab37d7:0
     • 5 ADA - a9a85a60...1ecba279:0
     ...

📊 TOTALS:
   Total Submissions: 9
   Total ADA Deposited: 70 ADA
```

## Adding New Helpers

When adding new helper scripts:
1. Place them in this directory
2. Add the script command to `package.json`
3. Update this README with usage instructions