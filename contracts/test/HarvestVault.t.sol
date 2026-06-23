// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HarvestVault} from "../src/HarvestVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockLendingPool} from "./mocks/MockLendingPool.sol";

contract HarvestVaultTest is Test {
    HarvestVault internal vault;
    MockERC20 internal usdc; // 6-dec
    MockLendingPool internal pool;

    address internal owner = address(0x0E1);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0);

    uint256 internal constant DEP = 100e6; // 100 USDC each
    uint64 internal depositDeadline;
    uint64 internal seasonEnd;

    function setUp() public {
        vault = new HarvestVault(owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        pool = new MockLendingPool(usdc);

        depositDeadline = uint64(block.timestamp + 1 days);
        seasonEnd = uint64(block.timestamp + 7 days);

        usdc.mint(alice, 1_000e6);
        usdc.mint(bob, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ------------------------------ helpers ----------------------------- //

    function _createSeason() internal returns (uint256 id) {
        vm.prank(owner);
        id = vault.createSeason(address(usdc), address(pool), depositDeadline, seasonEnd);
    }

    function _depositBoth(uint256 id) internal {
        vm.prank(alice);
        vault.deposit(id, DEP);
        vm.prank(bob);
        vault.deposit(id, DEP);
    }

    /// @dev fund the pool with `amount` underlying and credit it to the vault as yield
    function _accrue(uint256 amount) internal {
        usdc.mint(address(pool), amount);
        pool.accrueYield(address(vault), amount);
    }

    function _leaf(address a, uint256 amt) internal pure returns (bytes32) {
        return keccak256(abi.encode(a, amt));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    // ------------------------------ pause ------------------------------- //

    function test_pause_blocksDepositsAndSeasons() public {
        uint256 id = _createSeason();

        vm.prank(owner);
        vault.setPaused(true);
        assertTrue(vault.paused());

        vm.prank(alice);
        vm.expectRevert(bytes("HarvestVault: paused"));
        vault.deposit(id, DEP);

        vm.prank(owner);
        vm.expectRevert(bytes("HarvestVault: paused"));
        vault.createSeason(address(usdc), address(pool), depositDeadline, seasonEnd);

        // unpausing restores deposits
        vm.prank(owner);
        vault.setPaused(false);
        vm.prank(alice);
        vault.deposit(id, DEP);
        assertEq(vault.principalOf(id, alice), DEP);
    }

    function test_setPaused_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setPaused(true);
    }

    // ----------------------------- seasons ------------------------------ //

    function test_createSeason() public {
        uint256 id = _createSeason();
        assertEq(vault.activeSeasonForToken(address(usdc)), id);
        assertEq(uint8(vault.getSeason(id).status), uint8(HarvestVault.Status.Open));
    }

    function test_createSeason_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.createSeason(address(usdc), address(pool), depositDeadline, seasonEnd);
    }

    function test_createSeason_tokenBusy() public {
        _createSeason();
        vm.prank(owner);
        vm.expectRevert(bytes("HarvestVault: token busy"));
        vault.createSeason(address(usdc), address(pool), depositDeadline, seasonEnd);
    }

    // ----------------------------- deposit ------------------------------ //

    function test_deposit_suppliesToPool() public {
        uint256 id = _createSeason();
        vm.prank(alice);
        vault.deposit(id, DEP);

        assertEq(vault.principalOf(id, alice), DEP);
        assertEq(vault.getSeason(id).totalPrincipal, DEP);
        assertEq(usdc.balanceOf(address(pool)), DEP, "underlying supplied to market");
        assertEq(pool.aToken().balanceOf(address(vault)), DEP, "vault holds aTokens");
        assertEq(usdc.balanceOf(address(vault)), 0, "vault holds no idle underlying");
    }

    function test_deposit_revertAfterDeadline() public {
        uint256 id = _createSeason();
        vm.warp(depositDeadline + 1);
        vm.prank(alice);
        vm.expectRevert(bytes("HarvestVault: deposits closed"));
        vault.deposit(id, DEP);
    }

    // ----------------------------- finalize ----------------------------- //

    function test_finalize_computesYield() public {
        uint256 id = _createSeason();
        _depositBoth(id);
        _accrue(20e6); // 20 USDC of yield on 200 principal

        vm.warp(seasonEnd + 1);
        vm.prank(owner);
        vault.finalize(id, bytes32(0));

        HarvestVault.Season memory s = vault.getSeason(id);
        assertEq(uint8(s.status), uint8(HarvestVault.Status.Finalized));
        assertEq(s.redeemed, 2 * DEP + 20e6);
        assertEq(s.yieldPot, 20e6);
        assertEq(vault.activeSeasonForToken(address(usdc)), 0, "token freed");
        assertEq(usdc.balanceOf(address(vault)), 2 * DEP + 20e6, "all funds back in the vault");
    }

    function test_finalize_onlyOwnerAfterEnd() public {
        uint256 id = _createSeason();
        _depositBoth(id);

        vm.prank(owner);
        vm.expectRevert(bytes("HarvestVault: season not ended"));
        vault.finalize(id, bytes32(0));

        vm.warp(seasonEnd + 1);
        vm.prank(alice);
        vm.expectRevert(); // not owner
        vault.finalize(id, bytes32(0));
    }

    // ------------------------------ claims ------------------------------ //

    function test_claimPrincipal_noLoss() public {
        uint256 id = _createSeason();
        _depositBoth(id);
        _accrue(20e6);
        vm.warp(seasonEnd + 1);
        vm.prank(owner);
        vault.finalize(id, bytes32(0));

        uint256 aBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.claimPrincipal(id);
        assertEq(usdc.balanceOf(alice), aBefore + DEP, "principal returned in full");

        // double claim yields nothing
        vm.prank(alice);
        vm.expectRevert(bytes("HarvestVault: nothing to claim"));
        vault.claimPrincipal(id);
    }

    function test_noLoss_evenWithZeroYield() public {
        uint256 id = _createSeason();
        _depositBoth(id);
        vm.warp(seasonEnd + 1);
        vm.prank(owner);
        vault.finalize(id, bytes32(0));

        assertEq(vault.getSeason(id).yieldPot, 0);
        vm.prank(bob);
        vault.claimPrincipal(id);
        assertEq(usdc.balanceOf(bob), 1_000e6, "bob made whole (started 1000, deposited 100)");
    }

    function test_claimPrize_twoWinnersMerkle() public {
        uint256 id = _createSeason();
        _depositBoth(id);
        _accrue(30e6); // yieldPot = 30
        vm.warp(seasonEnd + 1);

        uint256 prizeA = 20e6;
        uint256 prizeB = 10e6;
        bytes32 la = _leaf(alice, prizeA);
        bytes32 lb = _leaf(bob, prizeB);
        bytes32 root = _hashPair(la, lb);

        vm.prank(owner);
        vault.finalize(id, root);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = lb;
        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = la;

        uint256 aBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.claimPrize(id, prizeA, proofA);
        assertEq(usdc.balanceOf(alice), aBefore + prizeA);

        vm.prank(bob);
        vault.claimPrize(id, prizeB, proofB);
        assertEq(vault.getSeason(id).prizeDistributed, prizeA + prizeB);

        // double claim blocked
        vm.prank(alice);
        vm.expectRevert(bytes("HarvestVault: prize claimed"));
        vault.claimPrize(id, prizeA, proofA);
    }

    function test_claimPrize_badProof() public {
        uint256 id = _createSeason();
        _depositBoth(id);
        _accrue(30e6);
        vm.warp(seasonEnd + 1);

        bytes32 root = _leaf(alice, 20e6); // single-leaf tree
        vm.prank(owner);
        vault.finalize(id, root);

        // bob is not in the tree
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(bob);
        vm.expectRevert(bytes("HarvestVault: bad proof"));
        vault.claimPrize(id, 20e6, empty);
    }

    function test_claimPrize_cannotExceedYield() public {
        uint256 id = _createSeason();
        _depositBoth(id);
        _accrue(5e6); // yieldPot = 5
        vm.warp(seasonEnd + 1);

        // malformed root grants alice more than the realised yield
        uint256 greedy = 10e6;
        bytes32 root = _leaf(alice, greedy);
        vm.prank(owner);
        vault.finalize(id, root);

        bytes32[] memory empty = new bytes32[](0);
        vm.prank(alice);
        vm.expectRevert(bytes("HarvestVault: exceeds yield"));
        vault.claimPrize(id, greedy, empty);
    }
}
