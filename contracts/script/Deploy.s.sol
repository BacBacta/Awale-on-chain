// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ReplayVerifier} from "../src/ReplayVerifier.sol";
import {Treasury} from "../src/Treasury.sol";
import {MatchEscrow} from "../src/MatchEscrow.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/// @notice Deploys the Awalé core: ReplayVerifier -> Treasury -> MatchEscrow,
///         allowlists the network's stablecoins, sets parameters, then hands
///         ownership to governance.
///
/// Config is chain-id driven:
///   - 42220     Celo mainnet  — real USDm/USDC/USDT token addresses
///   - 11142220  Celo Sepolia  — token addresses from env (USDM/USDC/USDT_ADDRESS)
///   - else      local/anvil   — deploys a mock stablecoin
///
/// Env:
///   PRIVATE_KEY (required)  deployer key
///   OWNER       (optional)  governance owner; defaults to the deployer
///   RAKE_BPS / CHALLENGE_WINDOW / MATCH_TTL (optional) override the defaults
///
/// Run (Celo Sepolia):
///   forge script script/Deploy.s.sol --rpc-url $CELO_SEPOLIA_RPC --broadcast --verify
contract Deploy is Script {
    uint16 internal constant DEFAULT_RAKE_BPS = 250; // 2.5%
    uint64 internal constant DEFAULT_CHALLENGE_WINDOW = 10 minutes;
    uint64 internal constant DEFAULT_MATCH_TTL = 1 days;

    // Celo mainnet stablecoin token addresses (architecture appendix)
    address internal constant CELO_USDM = 0x765DE816845861e75A25fCA122bb6898B8B1282a;
    address internal constant CELO_USDC = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C;
    address internal constant CELO_USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;

    struct Deployment {
        ReplayVerifier verifier;
        Treasury treasury;
        MatchEscrow escrow;
        address[] allowedTokens;
        address owner;
    }

    function run() external returns (Deployment memory d) {
        // Two ways to provide the signer:
        //   1. PRIVATE_KEY in contracts/.env  (0x + 64 hex)
        //   2. pass --private-key / --account on the forge CLI (no env needed)
        // A missing or placeholder PRIVATE_KEY falls back to (2) with a clear error
        // instead of a cryptic envUint parse revert.
        string memory pkStr = vm.envOr("PRIVATE_KEY", string(""));
        uint256 pk = bytes(pkStr).length == 66 ? vm.parseUint(pkStr) : 0;
        address deployer = pk != 0 ? vm.addr(pk) : msg.sender;
        require(deployer != address(0), "Deploy: set PRIVATE_KEY in .env (0x+64 hex) or pass --private-key");
        d.owner = vm.envOr("OWNER", deployer);

        uint16 rakeBps = uint16(vm.envOr("RAKE_BPS", uint256(DEFAULT_RAKE_BPS)));
        uint64 challengeWindow = uint64(vm.envOr("CHALLENGE_WINDOW", uint256(DEFAULT_CHALLENGE_WINDOW)));
        uint64 matchTtl = uint64(vm.envOr("MATCH_TTL", uint256(DEFAULT_MATCH_TTL)));

        if (pk != 0) {
            vm.startBroadcast(pk);
        } else {
            vm.startBroadcast();
        }

        d.allowedTokens = _resolveTokens(deployer);

        d.verifier = new ReplayVerifier();
        d.treasury = new Treasury(d.owner);
        // deployer owns the escrow during setup, then ownership is handed over
        d.escrow =
            new MatchEscrow(address(d.verifier), address(d.treasury), rakeBps, challengeWindow, matchTtl, deployer);

        for (uint256 i = 0; i < d.allowedTokens.length; i++) {
            d.escrow.setTokenAllowed(d.allowedTokens[i], true);
        }

        if (d.owner != deployer) {
            d.escrow.transferOwnership(d.owner);
        }

        vm.stopBroadcast();

        _logDeployment(d, rakeBps, challengeWindow, matchTtl);
    }

    /// @dev Pick the stablecoins to allowlist for the current network.
    /// @param mintTo recipient seeded with mock balances when mocks are deployed
    function _resolveTokens(address mintTo) internal returns (address[] memory tokens) {
        bool deployMocks = vm.envOr("DEPLOY_MOCK_TOKENS", false);
        require(!(deployMocks && block.chainid == 42220), "Deploy: refusing mock tokens on mainnet");

        if (deployMocks) {
            // self-contained testnet: deploy mock stablecoins (18/6/6) and seed
            // the deployer, so no external token addresses are needed.
            MockERC20 usdm = new MockERC20("Mock USDm", "mUSDm", 18);
            MockERC20 usdc = new MockERC20("Mock USDC", "mUSDC", 6);
            MockERC20 usdt = new MockERC20("Mock USDT", "mUSDT", 6);
            usdm.mint(mintTo, 1_000_000e18);
            usdc.mint(mintTo, 1_000_000e6);
            usdt.mint(mintTo, 1_000_000e6);
            tokens = new address[](3);
            tokens[0] = address(usdm);
            tokens[1] = address(usdc);
            tokens[2] = address(usdt);
        } else if (block.chainid == 42220) {
            tokens = new address[](3);
            tokens[0] = CELO_USDM;
            tokens[1] = CELO_USDC;
            tokens[2] = CELO_USDT;
        } else if (block.chainid == 11142220) {
            // Celo Sepolia: addresses are env-supplied (or set DEPLOY_MOCK_TOKENS)
            tokens = new address[](3);
            tokens[0] = vm.envAddress("USDM_ADDRESS");
            tokens[1] = vm.envAddress("USDC_ADDRESS");
            tokens[2] = vm.envAddress("USDT_ADDRESS");
        } else {
            // local/anvil: deploy a single mock stablecoin so e2e flows work
            MockERC20 mock = new MockERC20("Mock USD", "mUSD", 18);
            tokens = new address[](1);
            tokens[0] = address(mock);
        }
    }

    function _logDeployment(Deployment memory d, uint16 rakeBps, uint64 challengeWindow, uint64 matchTtl)
        internal
        pure
    {
        console2.log("== Awale deployment ==");
        console2.log("ReplayVerifier:", address(d.verifier));
        console2.log("Treasury:      ", address(d.treasury));
        console2.log("MatchEscrow:   ", address(d.escrow));
        console2.log("owner:         ", d.owner);
        console2.log("rakeBps:       ", rakeBps);
        console2.log("challengeWindow:", challengeWindow);
        console2.log("matchTtl:      ", matchTtl);
        for (uint256 i = 0; i < d.allowedTokens.length; i++) {
            console2.log("allowed token: ", d.allowedTokens[i]);
        }
    }
}
