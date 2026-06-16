import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/browser/index.ts",
    "src/transactions/index.ts",
    "src/validators/index.ts",
    "src/validators/Types/index.ts",
    "src/validators/GeneratedTypes/index.ts",
    "src/utils/index.ts",
    // Standalone entries so `./logger` and `./Config` subpaths resolve to
    // stable dist filenames (audit L9).
    "src/logger.ts",
    "src/Config.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2020",
  outDir: "dist",
});
