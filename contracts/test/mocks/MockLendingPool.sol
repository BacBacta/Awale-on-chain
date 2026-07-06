// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILendingPool} from "../../src/interfaces/ILendingPool.sol";

/// @dev Aave-style receipt token, mintable/burnable only by its pool.
contract MockAToken is ERC20 {
    address public immutable pool;

    constructor(address pool_) ERC20("Mock aToken", "maTKN") {
        pool = pool_;
    }

    modifier onlyPool() {
        require(msg.sender == pool, "only pool");
        _;
    }

    function mint(address to, uint256 amount) external onlyPool {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyPool {
        _burn(from, amount);
    }
}

/// @dev Minimal Aave-V3-style pool for deterministic HarvestVault tests.
///      `supply` pulls underlying and mints aTokens 1:1; `withdraw(max)` burns
///      the caller's aTokens and returns underlying. `accrueYield` simulates
///      interest by crediting a holder extra aTokens backed by extra underlying.
contract MockLendingPool is ILendingPool {
    IERC20 public immutable underlying;
    MockAToken public immutable aToken;

    constructor(IERC20 underlying_) {
        underlying = underlying_;
        aToken = new MockAToken(address(this));
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external override {
        require(asset == address(underlying), "wrong asset");
        underlying.transferFrom(msg.sender, address(this), amount);
        aToken.mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external override returns (uint256) {
        require(asset == address(underlying), "wrong asset");
        uint256 bal = aToken.balanceOf(msg.sender);
        uint256 amt = amount == type(uint256).max ? bal : amount;
        require(amt <= bal, "insufficient");
        aToken.burn(msg.sender, amt);
        underlying.transfer(to, amt);
        return amt;
    }

    /// @notice Test helper: credit `holder` `extra` yield, backed by underlying.
    function accrueYield(address holder, uint256 extra) external {
        // the extra underlying must already be funded to this pool by the test
        aToken.mint(holder, extra);
    }

    /// @notice Test helper: simulate a market loss (bad debt / de-peg) by burning
    ///         `loss` of `holder`'s aTokens. A later `withdraw(max)` then returns
    ///         less than was supplied — the M-02 shortfall scenario. The unbacked
    ///         underlying is simply left stranded in the pool.
    function simulateLoss(address holder, uint256 loss) external {
        aToken.burn(holder, loss);
    }
}
