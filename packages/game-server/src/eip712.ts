// Re-exported from the shared @awale/protocol package so the server and the
// mini-app sign against a single, parity-tested source of truth.
export {
  moveDigest,
  ackDigest,
  resultDigest,
  resignDigest,
  drawOfferDigest,
  recoverMoveSigner,
  stateHash,
  type MoveContext,
  type ResultContext,
  type MovePosition,
} from "../../protocol/src/eip712.js";
