// EIP-712 digests for Awalé, byte-identical to the on-chain contracts.
//
// These MUST match ReplayVerifier.moveDigest and MatchEscrow.resultDigest
// exactly: a per-match session key signs move digests in-app, and the server
// relays the signatures; if a digest here diverged from the contract by a
// single byte, every signature would fail to verify on-chain and the
// fraud-proof would be unusable. The parity test pins this against
// Solidity-generated vectors.

import {
  keccak256,
  encodeAbiParameters,
  toBytes,
  concatHex,
  recoverAddress,
  type Hex,
  type Address,
} from "viem";

const DOMAIN_TYPEHASH = keccak256(
  toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);
const MOVE_TYPEHASH = keccak256(toBytes("Move(uint256 matchId,uint256 ply,uint8 house,bytes32 state)"));
const TURNACK_TYPEHASH = keccak256(toBytes("TurnAck(uint256 matchId,uint256 ply,bytes32 state)"));
const RESULT_TYPEHASH = keccak256(toBytes("Result(uint256 matchId,uint8 winner)"));
// Off-chain only: authenticates a resign request to the game server (never
// submitted on-chain). Reuses the verifier domain like Move, distinct
// typehash so a resign signature can't be confused with a move signature.
const RESIGN_TYPEHASH = keccak256(toBytes("Resign(uint256 matchId,uint256 ply)"));
// Off-chain only: authenticates a mutual draw offer/accept. Distinct from
// Resign so a signature meaning "I concede" can never be replayed to mean
// "I agree to a draw" (or vice versa).
const DRAW_OFFER_TYPEHASH = keccak256(toBytes("DrawOffer(uint256 matchId,uint256 ply)"));

const VERIFIER_DOMAIN_NAME = "AwaleReplayVerifier";
const ESCROW_DOMAIN_NAME = "AwaleMatchEscrow";

function domainSeparator(name: string, chainId: bigint, verifyingContract: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_TYPEHASH, keccak256(toBytes(name)), keccak256(toBytes("1")), chainId, verifyingContract],
    ),
  );
}

function typedDataHash(domain: Hex, structHash: Hex): Hex {
  return keccak256(concatHex(["0x1901", domain, structHash]));
}

export interface MoveContext {
  chainId: bigint;
  verifier: Address;
}

/** The pre-move game state a move signature binds to. Superset-compatible with
 *  the engine's GameState, so `stateHash(gameState)` works directly. */
export interface MovePosition {
  pits: number[]; // 12 houses (0..5 player 0, 6..11 player 1)
  store0: number;
  store1: number;
  turn: number;
  noCaptureCount: number;
}

/** keccak of the pre-move game state a move signature binds to — byte-identical
 *  to ReplayVerifier.stateHash (abi.encode(pits[12], store0, store1, turn,
 *  noCaptureCount)). Binding each ply signature to its exact position closes
 *  ply-equivocation and keeps the on-chain forfeit history unforkable. */
export function stateHash(s: MovePosition): Hex {
  // pits is a fixed uint8[12] on-chain; viem types it as a 12-tuple
  const pits = s.pits as unknown as readonly [
    number, number, number, number, number, number, number, number, number, number, number, number,
  ];
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint8[12]" }, { type: "uint8" }, { type: "uint8" }, { type: "uint8" }, { type: "uint8" }],
      [pits, s.store0, s.store1, s.turn, s.noCaptureCount],
    ),
  );
}

export interface ResultContext {
  chainId: bigint;
  escrow: Address;
}

/** Digest a session key signs to authorise one move (ReplayVerifier.moveDigest).
 *  `state` is stateHash(pre-move position). */
export function moveDigest(matchId: bigint, ply: bigint, house: number, state: Hex, ctx: MoveContext): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint8" }, { type: "bytes32" }],
      [MOVE_TYPEHASH, matchId, ply, house, state],
    ),
  );
  return typedDataHash(domainSeparator(VERIFIER_DOMAIN_NAME, ctx.chainId, ctx.verifier), structHash);
}

/** Digest a session key signs to ACKNOWLEDGE it is their turn at `state` / `ply`
 *  (ReplayVerifier.ackDigest). The client signs this automatically on receiving
 *  the opponent's turn-flipping move; it is the anti-fabrication anchor that lets
 *  the opponent open a forfeit only against a position this player really saw. */
export function ackDigest(matchId: bigint, ply: bigint, state: Hex, ctx: MoveContext): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [TURNACK_TYPEHASH, matchId, ply, state],
    ),
  );
  return typedDataHash(domainSeparator(VERIFIER_DOMAIN_NAME, ctx.chainId, ctx.verifier), structHash);
}

/** Digest a session key signs to attest an agreed result (MatchEscrow.resultDigest). */
export function resultDigest(matchId: bigint, winner: number, ctx: ResultContext): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint8" }],
      [RESULT_TYPEHASH, matchId, winner],
    ),
  );
  return typedDataHash(domainSeparator(ESCROW_DOMAIN_NAME, ctx.chainId, ctx.escrow), structHash);
}

/** Digest a session key signs to authorise resigning (server-side auth only). */
export function resignDigest(matchId: bigint, ply: bigint, ctx: MoveContext): Hex {
  const structHash = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], [RESIGN_TYPEHASH, matchId, ply]),
  );
  return typedDataHash(domainSeparator(VERIFIER_DOMAIN_NAME, ctx.chainId, ctx.verifier), structHash);
}

/** Digest a session key signs to offer or accept a mutual draw (server-side auth only). */
export function drawOfferDigest(matchId: bigint, ply: bigint, ctx: MoveContext): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      [DRAW_OFFER_TYPEHASH, matchId, ply],
    ),
  );
  return typedDataHash(domainSeparator(VERIFIER_DOMAIN_NAME, ctx.chainId, ctx.verifier), structHash);
}

/** Recover the address that signed a move digest. */
export function recoverMoveSigner(
  matchId: bigint,
  ply: bigint,
  house: number,
  state: Hex,
  ctx: MoveContext,
  signature: Hex,
): Promise<Address> {
  return recoverAddress({ hash: moveDigest(matchId, ply, house, state, ctx), signature });
}
