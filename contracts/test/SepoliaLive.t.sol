// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MatchEscrow} from "../src/MatchEscrow.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice End-to-end check against the LIVE Celo Sepolia deployment, run on a
///         fork (no broadcast, no real key). Proves the deployed MatchEscrow
///         settles a real match: create -> join -> settleSigned -> payout + rake.
///
/// Run:
///   LIVE_ESCROW=0x.. LIVE_USDM=0x.. \
///   forge test --match-contract SepoliaLiveTest --fork-url celo_sepolia -vv
contract SepoliaLiveTest is Test {
    uint128 internal constant STAKE = 10e18;

    function test_live_happyPathSettlement() public {
        address escrowAddr = vm.envOr("LIVE_ESCROW", address(0));
        address usdmAddr = vm.envOr("LIVE_USDM", address(0));
        if (escrowAddr == address(0) || usdmAddr == address(0)) {
            vm.skip(true);
            return;
        }

        MatchEscrow escrow = MatchEscrow(escrowAddr);
        MockERC20 usdm = MockERC20(usdmAddr);

        (uint256 matchId, uint256 sk0, uint256 sk1) = _open(escrow, usdm);

        address p0 = makeAddr("p0"); // deterministic — same as in _open
        address treasury = escrow.treasury();
        bytes32 digest = escrow.resultDigest(matchId, 0);

        uint256 p0Before = usdm.balanceOf(p0);
        uint256 treasuryBefore = usdm.balanceOf(treasury);

        escrow.settleSigned(matchId, 0, _sig(sk0, digest), _sig(sk1, digest));

        uint256 pot = uint256(STAKE) * 2;
        uint256 rake = (pot * escrow.rakeBps()) / 10_000;
        assertEq(usdm.balanceOf(p0), p0Before + (pot - rake), "winner paid pot minus rake");
        assertEq(usdm.balanceOf(treasury), treasuryBefore + rake, "treasury received the rake");

        emit log_named_uint("matchId", matchId);
        emit log_named_uint("prize (wei)", pot - rake);
        emit log_named_uint("rake (wei)", rake);
    }

    function _open(MatchEscrow escrow, MockERC20 usdm)
        internal
        returns (uint256 matchId, uint256 sk0, uint256 sk1)
    {
        address p0 = makeAddr("p0");
        address p1 = makeAddr("p1");
        address s0;
        address s1;
        (s0, sk0) = makeAddrAndKey("session0");
        (s1, sk1) = makeAddrAndKey("session1");

        usdm.mint(p0, STAKE); // mock token has a public mint
        usdm.mint(p1, STAKE);

        vm.startPrank(p0);
        usdm.approve(address(escrow), STAKE);
        matchId = escrow.createMatch(address(usdm), STAKE, s0);
        vm.stopPrank();

        vm.startPrank(p1);
        usdm.approve(address(escrow), STAKE);
        escrow.joinMatch(matchId, s1);
        vm.stopPrank();
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
