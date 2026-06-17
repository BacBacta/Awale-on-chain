// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {ReplayVerifier} from "../src/ReplayVerifier.sol";
import {MatchEscrow} from "../src/MatchEscrow.sol";

/// @notice Emits EIP-712 digest vectors so the game server's TypeScript signing
///         code can be proven byte-identical to ReplayVerifier.moveDigest and
///         MatchEscrow.resultDigest. If these ever diverge, server-signed moves
///         and results would fail to verify on-chain — so this is a correctness
///         gate, mirrored by packages/game-server/test/eip712.parity.test.ts.
///
/// Run with:  forge script script/GenSigVectors.s.sol
/// Output:    test/fixtures/sig-vectors.json
contract GenSigVectors is Script {
    function run() external {
        ReplayVerifier verifier = new ReplayVerifier();
        MatchEscrow escrow =
            new MatchEscrow(address(verifier), address(0xBEEF), 250, 600, 1 days, address(0xABCD));

        // a small spread of inputs
        uint256[3] memory matchIds = [uint256(1), 42, 123456789];
        uint256[3] memory plies = [uint256(0), 7, 250];
        uint8[3] memory houses = [uint8(0), 3, 5];
        uint8[3] memory winners = [uint8(0), 1, 2];

        string memory moves = "";
        string memory results = "";
        for (uint256 i = 0; i < 3; i++) {
            if (i > 0) {
                moves = string(abi.encodePacked(moves, ","));
                results = string(abi.encodePacked(results, ","));
            }
            bytes32 mDigest = verifier.moveDigest(matchIds[i], plies[i], houses[i]);
            moves = string(
                abi.encodePacked(
                    moves,
                    '{"matchId":',
                    vm.toString(matchIds[i]),
                    ',"ply":',
                    vm.toString(plies[i]),
                    ',"house":',
                    vm.toString(uint256(houses[i])),
                    ',"digest":"',
                    vm.toString(mDigest),
                    '"}'
                )
            );
            bytes32 rDigest = escrow.resultDigest(matchIds[i], winners[i]);
            results = string(
                abi.encodePacked(
                    results,
                    '{"matchId":',
                    vm.toString(matchIds[i]),
                    ',"winner":',
                    vm.toString(uint256(winners[i])),
                    ',"digest":"',
                    vm.toString(rDigest),
                    '"}'
                )
            );
        }

        string memory json = string(
            abi.encodePacked(
                '{"chainId":',
                vm.toString(block.chainid),
                ',"verifier":"',
                vm.toString(address(verifier)),
                '","escrow":"',
                vm.toString(address(escrow)),
                '","moves":[',
                moves,
                '],"results":[',
                results,
                "]}"
            )
        );

        vm.writeFile("test/fixtures/sig-vectors.json", json);
    }
}
