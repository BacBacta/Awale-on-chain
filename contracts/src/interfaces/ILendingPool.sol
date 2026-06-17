// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Aave-V3-style lending pool interface used by HarvestVault.
///         Both Aave V3 and Moola (an Aave-V2 fork on Celo) expose these.
interface ILendingPool {
    /// @notice Supply `amount` of `asset`, crediting aTokens to `onBehalfOf`.
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    /// @notice Withdraw `amount` of `asset` to `to`. Pass `type(uint256).max`
    ///         to withdraw the caller's entire balance. Returns the amount sent.
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}
