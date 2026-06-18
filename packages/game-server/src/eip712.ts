// Re-exported from the shared @awale/protocol package so the server and the
// mini-app sign against a single, parity-tested source of truth.
export {
  moveDigest,
  resultDigest,
  recoverMoveSigner,
  type MoveContext,
  type ResultContext,
} from "../../protocol/src/eip712.js";
