import { configs as sundaeConfigs } from "@sundaeswap/eslint-config";

import globals from "globals";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...sundaeConfigs,
  {
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "no-use-before-define": "off",
      // The SDK's established public API uses unprefixed type/interface names
      // (BrowserConfig, BlockfrostConfig, KupmiosConfig, BrowserProviderOptions,
      // …) that consumers — including cosponsor-ui — already import. Enforcing
      // the I/T-prefix convention would be a breaking rename, so it's relaxed.
      "@typescript-eslint/naming-convention": "off",
    },
    languageOptions: {
      globals: {
        JSX: true,
        EventListenerOptions: true,
        EventListenerOrEventListenerObject: true,
        ...globals.browser,
        ...globals.node,
      },
    },
  },
];
