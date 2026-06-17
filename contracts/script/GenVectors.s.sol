// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {AwaleRules} from "../src/AwaleRules.sol";

/// @notice Generates cross-language parity vectors from the Solidity engine.
///         For a spread of pseudo-random games it records the move list and a
///         rolling hash mixed over *every* intermediate state, so the TypeScript
///         engine must reproduce each ply byte-for-byte, not just the result.
///
/// Run with:  forge script script/GenVectors.s.sol
/// Output:    test/fixtures/vectors.json (read by packages/engine parity test)
contract GenVectors is Script {
    uint256 internal constant NUM_GAMES = 40;
    uint256 internal constant MAX_PLIES = 400;

    function run() external {
        string memory out = "[";

        for (uint256 g = 0; g < NUM_GAMES; g++) {
            if (g > 0) out = string(abi.encodePacked(out, ","));
            out = string(abi.encodePacked(out, _playGame(g)));
        }

        out = string(abi.encodePacked(out, "]"));
        vm.writeFile("test/fixtures/vectors.json", out);
    }

    function _playGame(uint256 g) internal pure returns (string memory) {
        uint8 startTurn = uint8(g & 1);

        AwaleRules.GameState memory s = AwaleRules.initialState();
        s.turn = startTurn;

        bytes32 acc = keccak256("AWALE_VECTORS_V1");
        acc = _mix(acc, s); // include the opening position

        string memory movesCsv = "";
        uint256 plies = 0;

        for (uint256 ply = 0; ply < MAX_PLIES && !s.over; ply++) {
            uint8 mask = AwaleRules.legalMovesMask(s);
            uint8 pick = uint8(uint256(keccak256(abi.encode(g, ply))) % 6);
            uint8 house = _nthSetBit(mask, pick);

            if (ply > 0) movesCsv = string(abi.encodePacked(movesCsv, ","));
            movesCsv = string(abi.encodePacked(movesCsv, vm.toString(uint256(house))));

            s = AwaleRules.applyMove(s, house);
            acc = _mix(acc, s);
            plies++;
        }

        string memory head =
            string(abi.encodePacked('{"startTurn":', vm.toString(uint256(startTurn)), ',"moves":[', movesCsv, "]"));
        string memory mid = string(
            abi.encodePacked(
                ',"finalPits":[',
                _pitsCsv(s),
                "]",
                ',"store0":',
                vm.toString(uint256(s.store0)),
                ',"store1":',
                vm.toString(uint256(s.store1))
            )
        );
        string memory tail = string(
            abi.encodePacked(
                ',"turn":',
                vm.toString(uint256(s.turn)),
                ',"over":',
                s.over ? "true" : "false",
                ',"winner":',
                vm.toString(uint256(s.winner)),
                ',"plyHash":"',
                vm.toString(acc),
                '"}'
            )
        );
        plies; // recorded implicitly via moves length
        return string(abi.encodePacked(head, mid, tail));
    }

    /// @dev Rolling hash; the byte order is mirrored exactly in the TS engine.
    function _mix(bytes32 acc, AwaleRules.GameState memory s) internal pure returns (bytes32) {
        bytes memory pitBytes;
        for (uint8 i = 0; i < 12; i++) {
            pitBytes = bytes.concat(pitBytes, bytes1(s.pits[i]));
        }
        bytes memory scalars = abi.encodePacked(s.store0, s.store1, s.turn, s.over, s.winner);
        return keccak256(bytes.concat(acc, pitBytes, scalars));
    }

    function _pitsCsv(AwaleRules.GameState memory s) internal pure returns (string memory csv) {
        for (uint8 i = 0; i < 12; i++) {
            if (i > 0) csv = string(abi.encodePacked(csv, ","));
            csv = string(abi.encodePacked(csv, vm.toString(uint256(s.pits[i]))));
        }
    }

    function _nthSetBit(uint8 mask, uint8 k) internal pure returns (uint8) {
        uint8 count = 0;
        for (uint8 b = 0; b < 6; b++) {
            if (mask & (uint8(1) << b) != 0) count++;
        }
        require(count > 0, "no legal move");
        uint8 target = k % count;
        uint8 seen = 0;
        for (uint8 b = 0; b < 6; b++) {
            if (mask & (uint8(1) << b) != 0) {
                if (seen == target) return b;
                seen++;
            }
        }
        revert("unreachable");
    }
}
