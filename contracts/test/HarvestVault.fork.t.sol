// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HarvestVault} from "../src/HarvestVault.sol";

/// @notice Integration test against a real Celo lending market on a mainnet fork.
///         Gated on env so CI (which has no archive RPC) skips it cleanly; provide
///         all three to run it:
///
///           CELO_FORK_RPC=https://forno.celo.org \
///           AAVE_POOL=0x...   # the lending Pool
///           AAVE_TOKEN=0x...  # a supported stablecoin reserve (e.g. USDC/USDm)
///           forge test --match-contract HarvestVaultForkTest -vv
///
/// It runs the full no-loss lifecycle (createSeason → deposit → finalize →
/// claimPrincipal) and asserts the vault returns at least the principal.
contract HarvestVaultForkTest is Test {
    function test_fork_noLossLifecycle() public {
        string memory rpc = vm.envOr("CELO_FORK_RPC", string(""));
        address poolAddr = vm.envOr("AAVE_POOL", address(0));
        address tokenAddr = vm.envOr("AAVE_TOKEN", address(0));

        if (bytes(rpc).length == 0 || poolAddr == address(0) || tokenAddr == address(0)) {
            vm.skip(true);
            return;
        }

        vm.createSelectFork(rpc);

        HarvestVault vault = new HarvestVault(address(this));
        vault.setSeasonsUnlocked(true); // audit gate — unlock for the fork lifecycle
        IERC20 token = IERC20(tokenAddr);

        uint256 amount = 1_000 * (10 ** _decimals(tokenAddr));
        deal(tokenAddr, address(this), amount);

        uint64 depositDeadline = uint64(block.timestamp + 1 days);
        uint64 seasonEnd = uint64(block.timestamp + 30 days);
        uint256 id = vault.createSeason(tokenAddr, poolAddr, depositDeadline, seasonEnd);

        token.approve(address(vault), amount);
        vault.deposit(id, amount);

        // let interest accrue, then finalize and reclaim principal
        vm.warp(seasonEnd + 1);
        vault.finalize(id, bytes32(0));

        HarvestVault.Season memory s = vault.getSeason(id);
        assertGe(s.redeemed, amount, "no-loss: at least principal is recovered");

        uint256 before = token.balanceOf(address(this));
        vault.claimPrincipal(id);
        assertEq(token.balanceOf(address(this)), before + amount, "full principal returned");
    }

    function _decimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        return ok ? abi.decode(data, (uint8)) : 18;
    }
}
