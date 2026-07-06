// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {HarvestVault} from "../src/HarvestVault.sol";
import {MockLendingPool} from "../test/mocks/MockLendingPool.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Deploys a self-contained, demonstrable no-loss league on a testnet:
///         a faucet stablecoin (public mint), a mock Aave-style lending pool,
///         the HarvestVault, and an open season. Real markets (Aave/Moola) are
///         used on mainnet instead of the mock.
///
/// Env:
///   PRIVATE_KEY (required)  deployer key
///   OWNER       (optional)  vault owner; defaults to the deployer
///   LEAGUE_TOKEN (optional) existing stablecoin to use; else a faucet mock is deployed
///   DEPOSIT_DAYS (optional, default 3)  deposit window length
///   SEASON_DAYS  (optional, default 7)  season length (>= DEPOSIT_DAYS)
///   SEED_YIELD   (optional, default 0)  pre-seed yield (token units) so prizes are non-zero
///
/// Run (Celo Sepolia):
///   forge script script/DeployLeague.s.sol --rpc-url $CELO_SEPOLIA_RPC --broadcast --verify
contract DeployLeague is Script {
    function run() external {
        // This script wires a MOCK lending pool — a testnet demo only. The real
        // vault ships to mainnet locked (seasonsUnlocked = false) and is unlocked
        // by governance only after the external audit clears the integration.
        require(block.chainid != 42220, "DeployLeague: mock pool is testnet-only");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("OWNER", deployer);
        uint256 depositDays = vm.envOr("DEPOSIT_DAYS", uint256(3));
        uint256 seasonDays = vm.envOr("SEASON_DAYS", uint256(7));
        uint256 seedYield = vm.envOr("SEED_YIELD", uint256(0));
        address tokenEnv = vm.envOr("LEAGUE_TOKEN", address(0));

        vm.startBroadcast(pk);

        // 1. league stablecoin (faucet mock unless an existing token is given)
        address token = tokenEnv;
        if (token == address(0)) {
            MockERC20 mock = new MockERC20("Awale League USD", "aUSD", 18);
            token = address(mock);
        }

        // 2. mock Aave-style lending market
        MockLendingPool pool = new MockLendingPool(IERC20(token));

        // 3. the vault — ships locked; unlock here for the self-contained
        //    testnet demo (mainnet stays locked until the audit clears it)
        HarvestVault vault = new HarvestVault(owner);
        vault.setSeasonsUnlocked(true);

        // 4. open a season
        uint64 depositDeadline = uint64(block.timestamp + depositDays * 1 days);
        uint64 seasonEnd = uint64(block.timestamp + seasonDays * 1 days);
        // createSeason is onlyOwner; if owner != deployer, this must be run by the owner.
        uint256 seasonId = vault.createSeason(token, address(pool), depositDeadline, seasonEnd);

        // 5. optionally pre-seed yield so finalize produces a non-zero prize pot
        if (seedYield > 0) {
            // fund the pool with the extra underlying, then credit it to the vault's position
            MockERC20(token).mint(address(pool), seedYield);
            pool.accrueYield(address(vault), seedYield);
        }

        vm.stopBroadcast();

        console2.log("League token:   ", token);
        console2.log("LendingPool:    ", address(pool));
        console2.log("HarvestVault:   ", address(vault));
        console2.log("Season id:      ", seasonId);
        console2.log("Deposit until:  ", depositDeadline);
        console2.log("Season end:     ", seasonEnd);
    }
}
