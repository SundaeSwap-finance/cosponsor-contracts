/**
 * Silent-by-default logger for library code.
 *
 * Defaults to silent so the SDK does not spam host applications.
 * Enable at build-time via COSPONSOR_SDK_DEBUG=1 (Node) or at runtime via
 * setLoggerEnabled(true) from the consumer (works in browser too).
 *
 * error() always surfaces regardless of the flag.
 */

let enabled =
  typeof process !== "undefined" &&
  process.env !== undefined &&
  process.env.COSPONSOR_SDK_DEBUG === "1";

export const setLoggerEnabled = (on: boolean): void => {
  enabled = on;
};

/* eslint-disable no-console */
export const logger = {
  debug: (...args: unknown[]): void => {
    if (enabled) console.log(...args);
  },
  info: (...args: unknown[]): void => {
    if (enabled) console.log(...args);
  },
  warn: (...args: unknown[]): void => {
    if (enabled) console.warn(...args);
  },
  error: (...args: unknown[]): void => {
    console.error(...args);
  },
};
/* eslint-enable no-console */
