import WebSocket from "ws";
import { Core } from "@blaze-cardano/sdk";

export interface OgmiosSubmissionResult {
  success: boolean;
  txId?: string;
  error?: string;
}

export class OgmiosTransactionSubmitter {
  private ogmiosUrl: string;
  private debugMode: boolean;

  constructor(ogmiosUrl: string, debugMode: boolean = false) {
    this.ogmiosUrl = ogmiosUrl;
    this.debugMode = debugMode;
  }

  private log(...args: any[]): void {
    if (this.debugMode) {
      console.log(...args);
    }
  }

  async submitTransaction(
    builtTx: any,
    witnessSet: any,
  ): Promise<OgmiosSubmissionResult> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.ogmiosUrl);
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.terminate();
          resolve({
            success: false,
            error: "WebSocket connection timeout",
          });
        }
      }, 30000); // 30 second timeout

      ws.on("open", async () => {
        try {
          // Method 1: Try to get the already complete transaction CBOR from builtTx
          let fullTxCbor: string;

          try {
            // The built transaction CBOR doesn't include witnesses, we need to construct the full transaction
            const originalTxCbor = builtTx.toCbor();
            const witnessCbor = witnessSet.toCbor();

            this.log("Constructing complete transaction CBOR...");
            this.log(`Original tx CBOR: ${originalTxCbor.length} chars`);
            this.log(`Witness CBOR: ${witnessCbor.length} chars`);

            // Parse the original transaction CBOR to understand its structure
            // The original is likely just [body, empty_witnesses, true]
            // We need to replace empty_witnesses with our actual witnesses

            // Get components separately for proper construction
            const txBodyCbor = builtTx.body().toCbor();
            const hasAuxData = builtTx.auxiliaryData() !== undefined;

            if (hasAuxData) {
              const auxCbor = builtTx.auxiliaryData()!.toCbor();
              // [body, witnessSet, true, auxiliaryData] = 4-element array
              fullTxCbor = `84${txBodyCbor.substring(2)}${witnessCbor.substring(2)}f5${auxCbor.substring(2)}`;
            } else {
              // [body, witnessSet, true] = 3-element array
              fullTxCbor = `83${txBodyCbor.substring(2)}${witnessCbor.substring(2)}f5`;
            }

            this.log(`Constructed tx has aux data: ${hasAuxData}`);
            this.log(`Body CBOR: ${txBodyCbor.length} chars`);
            this.log(`Final transaction CBOR: ${fullTxCbor.length} chars`);
          } catch (originalError) {
            this.log("Built transaction CBOR failed, constructing manually...");

            // Method 2: Manual construction if the above fails
            const txBodyCbor = builtTx.body().toCbor();
            const witnessCbor = witnessSet.toCbor();

            this.log(`Body CBOR: ${txBodyCbor.length} chars`);
            this.log(`Witness CBOR: ${witnessCbor.length} chars`);

            // CBOR format: [body, witnessSet, true] (3-element array)
            fullTxCbor = `83${txBodyCbor.substring(2)}${witnessCbor.substring(2)}f5`;
          }

          this.log(`Final transaction CBOR: ${fullTxCbor.length} chars`);
          this.log(`CBOR starts with: ${fullTxCbor.substring(0, 20)}...`);

          // Submit using Ogmios JSON-RPC
          const submitRequest = {
            jsonrpc: "2.0",
            method: "submitTransaction",
            params: {
              transaction: {
                cbor: fullTxCbor,
              },
            },
            id: `tx-submit-${Date.now()}`,
          };

          this.log("Submitting via Ogmios WebSocket...");
          ws.send(JSON.stringify(submitRequest));
        } catch (error) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve({
              success: false,
              error: `CBOR construction failed: ${error}`,
            });
          }
        }
      });

      ws.on("message", (data) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);

          try {
            const response = JSON.parse(data.toString());

            if (response.error) {
              this.log(`Ogmios error: ${JSON.stringify(response.error)}`);
              ws.close();
              resolve({
                success: false,
                error: `Ogmios error: ${response.error.message || JSON.stringify(response.error)}`,
              });
            } else {
              // Successful submission - Ogmios returns the transaction ID
              const txId = response.result;
              this.log(`Ogmios success: ${txId || "Transaction submitted"}`);
              ws.close();
              resolve({
                success: true,
                txId: txId || "unknown",
              });
            }
          } catch (error) {
            ws.close();
            resolve({
              success: false,
              error: `Failed to parse Ogmios response: ${error}`,
            });
          }
        }
      });

      ws.on("error", (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({
            success: false,
            error: `WebSocket error: ${error.message}`,
          });
        }
      });

      ws.on("close", (code, reason) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          if (code !== 1000) {
            resolve({
              success: false,
              error: `WebSocket closed unexpectedly: ${code} ${reason}`,
            });
          } else {
            resolve({
              success: false,
              error: "WebSocket closed before receiving response",
            });
          }
        }
      });
    });
  }

  async evaluateTransaction(builtTx: any, witnessSet: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.ogmiosUrl);

      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error("WebSocket connection timeout"));
      }, 15000);

      ws.on("open", async () => {
        try {
          const txBodyCbor = builtTx.body().toCbor();
          const witnessCbor = witnessSet.toCbor();
          const fullTxCbor = `83${txBodyCbor.substring(2)}${witnessCbor.substring(2)}f5`;

          const evaluateRequest = {
            jsonrpc: "2.0",
            method: "evaluateTransaction",
            params: {
              transaction: {
                cbor: fullTxCbor,
              },
            },
            id: `tx-eval-${Date.now()}`,
          };

          ws.send(JSON.stringify(evaluateRequest));
        } catch (error) {
          clearTimeout(timeout);
          ws.close();
          reject(error);
        }
      });

      ws.on("message", (data) => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data.toString());
          ws.close();

          if (response.error) {
            reject(
              new Error(`Ogmios evaluation error: ${response.error.message}`),
            );
          } else {
            resolve(response.result);
          }
        } catch (error) {
          ws.close();
          reject(error);
        }
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}
