// CIP-25 chunking lives in the Node-safe shared module now (audit H10).
// Re-exported here for back-compat with existing `./metadataUtils` imports.
export { chunkCip25Text, chunkUtf8 } from "../utils/cip25.js";
