// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HarvestVault} from "../src/HarvestVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockLendingPool} from "./mocks/MockLendingPool.sol";

/// @dev Random-walks one season's lifecycle: deposits (while open), yield
///      accrual, a single finalize, then principal claims. Owns the vault so it
///      can finalize autonomously. Ghost totals let the invariants assert the
///      two properties that matter for players' money:
///        - the vault always holds at least the still-unclaimed principal;
///        - it never pays out more principal in aggregate than was deposited.
contract HarvestHandler is Test {
    HarvestVault public vault;
    MockERC20 public usdc;
    MockLendingPool public pool;
    uint256 public seasonId;
    uint64 public seasonEnd;

    address[4] public players;
    uint256 public ghostDeposited;
    uint256 public ghostClaimed;
    bool public finalized;

    constructor(HarvestVault v, MockERC20 t, MockLendingPool p, uint256 id, uint64 end) {
        vault = v;
        usdc = t;
        pool = p;
        seasonId = id;
        seasonEnd = end;
        for (uint256 i; i < 4; i++) {
            address who = address(uint160(0xA11CE0 + i));
            players[i] = who;
            usdc.mint(who, 1_000_000e6);
            vm.prank(who);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function deposit(uint256 who, uint256 amount) external {
        if (finalized) return;
        if (block.timestamp > vault.getSeason(seasonId).depositDeadline) return;
        address p = players[who % 4];
        uint256 amt = bound(amount, 1, 100_000e6);
        vm.prank(p);
        vault.deposit(seasonId, amt);
        ghostDeposited += amt;
    }

    function accrue(uint256 amount) external {
        if (finalized) return;
        uint256 amt = bound(amount, 0, 10_000e6);
        if (amt == 0) return;
        usdc.mint(address(pool), amt);
        pool.accrueYield(address(vault), amt);
    }

    function finalizeSeason() external {
        if (finalized || ghostDeposited == 0) return;
        vm.warp(seasonEnd + 1);
        vault.finalize(seasonId, bytes32(0)); // handler is the owner
        finalized = true;
    }

    function claimPrincipal(uint256 who) external {
        if (!finalized) return;
        address p = players[who % 4];
        uint256 owed = vault.principalOf(seasonId, p);
        if (owed == 0) return;
        vm.prank(p);
        vault.claimPrincipal(seasonId);
        ghostClaimed += owed;
    }

    /// underlying the vault can still draw on: idle balance + its pool position.
    function vaultBacking() external view returns (uint256) {
        return usdc.balanceOf(address(vault)) + pool.aToken().balanceOf(address(vault));
    }
}

contract HarvestVaultInvariantTest is Test {
    HarvestVault internal vault;
    MockERC20 internal usdc;
    MockLendingPool internal pool;
    HarvestHandler internal handler;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        pool = new MockLendingPool(usdc);
        vault = new HarvestVault(address(this));

        uint64 depositDeadline = uint64(block.timestamp + 20 days);
        uint64 seasonEnd = uint64(block.timestamp + 30 days);
        uint256 id = vault.createSeason(address(usdc), address(pool), depositDeadline, seasonEnd);

        handler = new HarvestHandler(vault, usdc, pool, id, seasonEnd);
        // hand the vault to the handler so it can finalize on its own
        vault.transferOwnership(address(handler));

        targetContract(address(handler));
    }

    /// No-loss solvency: the vault's drawable underlying (idle + still in the
    /// market) is always at least the principal that has not yet been claimed.
    function invariant_solventForUnclaimedPrincipal() public view {
        uint256 unclaimed = handler.ghostDeposited() - handler.ghostClaimed();
        assertGe(handler.vaultBacking(), unclaimed, "vault cannot cover principal");
    }

    /// The protocol never returns more principal than was ever deposited.
    function invariant_neverOverpaysPrincipal() public view {
        assertLe(handler.ghostClaimed(), handler.ghostDeposited(), "overpaid principal");
    }

    /// The prize solvency guard is never violated: distributed ≤ realised yield.
    function invariant_prizeWithinYield() public view {
        HarvestVault.Season memory s = vault.getSeason(handler.seasonId());
        assertLe(s.prizeDistributed, s.yieldPot, "prizes exceed yield");
    }
}
