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
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2020",
  outDir: "dist",
  // Preserve directory structure for deep imports
  splitting: false,
});
