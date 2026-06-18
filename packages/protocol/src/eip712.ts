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
const MOVE_TYPEHASH = keccak256(toBytes("Move(uint256 matchId,uint256 ply,uint8 house)"));
const RESULT_TYPEHASH = keccak256(toBytes("Result(uint256 matchId,uint8 winner)"));

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

export interface ResultContext {
  chainId: bigint;
  escrow: Address;
}

/** Digest a session key signs to authorise one move (ReplayVerifier.moveDigest). */
export function moveDigest(matchId: bigint, ply: bigint, house: number, ctx: MoveContext): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint8" }],
      [MOVE_TYPEHASH, matchId, ply, house],
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

/** Recover the address that signed a move digest. */
export function recoverMoveSigner(
  matchId: bigint,
  ply: bigint,
  house: number,
  ctx: MoveContext,
  signature: Hex,
): Promise<Address> {
  return recoverAddress({ hash: moveDigest(matchId, ply, house, ctx), signature });
}
