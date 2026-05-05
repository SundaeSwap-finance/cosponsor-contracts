// Copies the freshly built SDK dist into the consuming UI's linked path.
// Local development helper - not shipped or run by SDK consumers.
//
// Usage: COSPONSOR_UI_PATH=/path/to/cosponsor-ui bun run copy-to-ui

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

config();

const uiPath = process.env.COSPONSOR_UI_PATH;

if (!uiPath) {
  console.error(
    "Error: COSPONSOR_UI_PATH is not set.\n" +
      "Set it to your local cosponsor-ui repo path, e.g.:\n" +
      "  COSPONSOR_UI_PATH=/path/to/cosponsor-ui bun run copy-to-ui\n" +
      "Or add COSPONSOR_UI_PATH=... to offchain/.env",
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const offchainRoot = resolve(here, "..");
const distSrc = join(offchainRoot, "dist");
const pkgSrc = join(offchainRoot, "package.json");
const dest = join(uiPath, "src", "lib", "cosponsor-sdk");

if (!existsSync(distSrc)) {
  console.error(
    `Error: ${distSrc} does not exist. Run 'bun run build' first.`,
  );
  process.exit(1);
}

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
cpSync(distSrc, dest, { recursive: true });
cpSync(pkgSrc, join(dest, "package.json"));

console.log(`Copied SDK dist + package.json to ${dest}`);
