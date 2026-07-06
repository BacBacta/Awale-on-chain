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
        // yield is locked by default (audit gate); unlock for the functional tests
        vm.prank(owner);
        vault.setSeasonsUnlocked(true);

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

    // -------------------- audit gate (locked by default) -------------------- //

    // A fresh vault is inert: seasons are locked, so no season can open and no
    // deposit can enter until governance unlocks post-audit.
    function test_gate_lockedByDefault() public {
        HarvestVault fresh = new HarvestVault(owner);
        assertFalse(fresh.seasonsUnlocked(), "locked by default");
        vm.prank(owner);
        vm.expectRevert(bytes("HarvestVault: locked pending audit"));
        fresh.createSeason(address(usdc), address(pool), depositDeadline, seasonEnd);
    }

    function test_gate_onlyOwnerCanUnlock() public {
        vm.prank(alice);
        vm.expectRevert(); // Ownable: not owner
        vault.setSeasonsUnlocked(false);
    }

    // Re-locking is a pause: it blocks new deposits but never claims/finalize,
    // so funds already in a season are always recoverable.
    function test_gate_pauseBlocksDepositsButNotExits() public {
        uint256 id = _createSeason();
        vm.prank(alice);
        vault.deposit(id, DEP);

        // governance pauses the yield system mid-season
        vm.prank(owner);
        vault.setSeasonsUnlocked(false);

        // new deposits are frozen
        vm.prank(bob);
        vm.expectRevert(bytes("HarvestVault: deposits locked"));
        vault.deposit(id, DEP);

        // but finalize and principal claims still work — funds never trapped
        vm.warp(seasonEnd + 1);
        vm.prank(owner);
        vault.finalize(id, bytes32(0));
        uint256 aBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.claimPrincipal(id);
        assertEq(usdc.balanceOf(alice), aBefore + DEP, "principal recoverable while paused");
    }

    // ----------------------- [M-02] shortfall pro-rata ----------------------- //

    // On a market shortfall (bad debt / de-peg), the recovered amount is shared
    // PRO-RATA across all depositors — every claimant is paid their fair share
    // and NONE reverts. Before the fix this was first-come-first-served: early
    // claimants took full principal, late ones found an empty vault and reverted.
    function test_claimPrincipal_shortfallSharedProRata() public {
        uint256 id = _createSeason();
        _depositBoth(id); // totalPrincipal = 200 USDC (100 each)

        // the market loses 50 USDC of the position (25%) before season end
        pool.simulateLoss(address(vault), 50e6);
        vm.warp(seasonEnd + 1);
        vm.prank(owner);
        vault.finalize(id, bytes32(0));

        HarvestVault.Season memory s = vault.getSeason(id);
        assertEq(s.redeemed, 150e6, "vault recovered 150 of 200");
        assertEq(s.yieldPot, 0, "no yield on a shortfall");

        // each recovers principal * redeemed / totalPrincipal = 100 * 150/200 = 75
        assertEq(vault.claimablePrincipal(id, alice), 75e6, "alice pro-rata share");

        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);
        vm.prank(alice);
        vault.claimPrincipal(id);
        vm.prank(bob); // the LATE claimant must NOT revert (the old FCFS bug)
        vault.claimPrincipal(id);

        assertEq(usdc.balanceOf(alice), aBefore + 75e6, "alice got her 75");
        assertEq(usdc.balanceOf(bob), bBefore + 75e6, "bob (late) also got his 75");
        // the loss (50) was shared equally: each lost 25, nobody was wiped out
        assertEq(usdc.balanceOf(address(vault)), 0, "vault fully drained, no over-pay");
    }

    // The sum of pro-rata payouts can never exceed what the vault recovered,
    // for any deposit split and any shortfall (rounding is down per player).
    function testFuzz_shortfallNeverOverPays(uint256 a, uint256 b, uint256 loss) public {
        a = bound(a, 1e6, 500e6);
        b = bound(b, 1e6, 500e6);
        uint256 id = _createSeason();
        vm.prank(alice);
        vault.deposit(id, a);
        vm.prank(bob);
        vault.deposit(id, b);
        uint256 total = a + b;
        loss = bound(loss, 1, total); // at least 1 unit lost, at most everything

        pool.simulateLoss(address(vault), loss);
        vm.warp(seasonEnd + 1);
        vm.prank(owner);
        vault.finalize(id, bytes32(0));

        uint256 redeemed = vault.getSeason(id).redeemed;
        uint256 payA = vault.claimablePrincipal(id, alice);
        uint256 payB = vault.claimablePrincipal(id, bob);
        assertLe(payA + payB, redeemed, "pro-rata payouts never exceed the recovered amount");

        // both claims succeed regardless of order — no late-claimant lockout
        vm.prank(bob);
        vault.claimPrincipal(id);
        vm.prank(alice);
        vault.claimPrincipal(id);
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

    // ------------------------------- fuzz ------------------------------- //

    /// @dev deposit for a fresh, on-the-fly funded player.
    function _freshDeposit(uint256 id, uint256 salt, uint256 amount) internal returns (address who, uint256 amt) {
        who = address(uint160(uint256(keccak256(abi.encode("player", salt)))));
        amt = bound(amount, 1, 1_000_000e6);
        usdc.mint(who, amt);
        vm.startPrank(who);
        usdc.approve(address(vault), amt);
        vault.deposit(id, amt);
        vm.stopPrank();
    }

    /// No-loss under arbitrary deposits and arbitrary yield: every depositor
    /// gets their *exact* principal back, the realised yield equals what
    /// accrued, and only that yield is left in the vault afterwards.
    function testFuzz_noLossManyDepositors(uint256[5] memory amounts, uint256 yield) public {
        uint256 id = _createSeason();
        address[5] memory who;
        uint256[5] memory dep;
        uint256 total;
        for (uint256 i; i < 5; i++) {
            (who[i], dep[i]) = _freshDeposit(id, i, amounts[i]);
            total += dep[i];
        }
        yield = bound(yield, 0, 5_000_000e6);
        if (yield > 0) _accrue(yield);

        vm.warp(seasonEnd + 1);
        vm.prank(owner);
        vault.finalize(id, bytes32(0));

        assertEq(vault.getSeason(id).totalPrincipal, total, "principal tallied");
        assertEq(vault.getSeason(id).yieldPot, yield, "yieldPot = redeemed - principal");

        for (uint256 i; i < 5; i++) {
            uint256 before = usdc.balanceOf(who[i]);
            vm.prank(who[i]);
            vault.claimPrincipal(id);
            assertEq(usdc.balanceOf(who[i]) - before, dep[i], "exact principal returned");
        }
        assertEq(usdc.balanceOf(address(vault)), yield, "only the yield remains");
    }

    /// The solvency guard holds for ANY finalized prize amount: a prize is
    /// payable iff it fits within the realised yield, and a paid prize never
    /// pushes prizeDistributed past the pot — even from a malformed root.
    function testFuzz_prizeNeverExceedsYield(uint256 yield, uint256 grant) public {
        uint256 id = _createSeason();
        _depositBoth(id);
        yield = bound(yield, 0, 1_000_000e6);
        if (yield > 0) _accrue(yield);
        grant = bound(grant, 1, 2_000_000e6);

        vm.warp(seasonEnd + 1);
        bytes32 root = _leaf(alice, grant); // single-leaf tree → empty proof
        vm.prank(owner);
        vault.finalize(id, root);

        uint256 pot = vault.getSeason(id).yieldPot;
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(alice);
        if (grant > pot) {
            vm.expectRevert(bytes("HarvestVault: exceeds yield"));
            vault.claimPrize(id, grant, empty);
        } else {
            vault.claimPrize(id, grant, empty);
            assertLe(vault.getSeason(id).prizeDistributed, pot, "distributed within pot");
        }
    }

    // ---------------- pre-mainnet pass: protocol yield fee ---------------- //

    address internal feeTreasury = address(0xFEE);

    function test_yieldFee_takenFromYieldOnly_principalUntouched() public {
        vm.prank(owner);
        vault.setYieldFee(feeTreasury, 2000); // 20% of yield

        uint256 id = _createSeason();
        _depositBoth(id);
        _accrue(30e6); // 30 yield on 200 principal

        vm.warp(seasonEnd + 1);
        vm.prank(owner);
        vault.finalize(id, bytes32(0));

        assertEq(usdc.balanceOf(feeTreasury), 6e6, "20% of the yield");
        assertEq(vault.getSeason(id).yieldPot, 24e6, "players share the rest");

        // the no-loss promise is untouched: full principal back
        uint256 aBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.claimPrincipal(id);
        assertEq(usdc.balanceOf(alice), aBefore + DEP, "principal intact");
    }

    function test_yieldFee_zeroByDefault_behaviourUnchanged() public {
        uint256 id = _createSeason();
        _depositBoth(id);
        _accrue(30e6);
        vm.warp(seasonEnd + 1);
        vm.prank(owner);
        vault.finalize(id, bytes32(0));
        assertEq(vault.getSeason(id).yieldPot, 30e6, "100% of yield to players");
        assertEq(usdc.balanceOf(feeTreasury), 0);
    }

    function test_setYieldFee_capAndAuth() public {
        vm.prank(owner);
        vm.expectRevert(bytes("HarvestVault: fee too high"));
        vault.setYieldFee(feeTreasury, 3001);

        vm.prank(owner);
        vm.expectRevert(bytes("HarvestVault: treasury zero"));
        vault.setYieldFee(address(0), 100);

        vm.prank(alice);
        vm.expectRevert();
        vault.setYieldFee(feeTreasury, 100);
    }

    function testFuzz_yieldFee_neverTouchesPrincipal(uint256 yield, uint16 bps) public {
        yield = bound(yield, 0, 1_000_000e6);
        bps = uint16(bound(bps, 0, 3000));
        vm.prank(owner);
        vault.setYieldFee(feeTreasury, bps);

        uint256 id = _createSeason();
        _depositBoth(id);
        if (yield > 0) _accrue(yield);
        vm.warp(seasonEnd + 1);
        vm.prank(owner);
        vault.finalize(id, bytes32(0));

        uint256 fee = (yield * bps) / 10_000;
        assertEq(usdc.balanceOf(feeTreasury), fee, "fee is a slice of yield");
        assertEq(vault.getSeason(id).yieldPot, yield - fee, "pot = yield - fee");

        uint256 aBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.claimPrincipal(id);
        assertEq(usdc.balanceOf(alice), aBefore + DEP, "principal ALWAYS intact");
    }
}
