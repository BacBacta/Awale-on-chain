// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Treasury — protocol-fee custody for Awalé
/// @notice Holds the rake routed here by {MatchEscrow} (and, later, the protocol
///         share of vault yield). Governance withdraws accumulated stablecoin
///         fees to wherever it directs them.
///
/// @dev Deliberately a passive, decoupled vault: it has no knowledge of
///      MatchEscrow and needs no privileged caller. Fees arrive as plain ERC-20
///      transfers, so per-match revenue is read off MatchEscrow's `FeeCollected`
///      events; this contract's job is custody and controlled withdrawal. Owner
///      is expected to be a timelock + multisig before mainnet (architecture §13).
contract Treasury is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    event Withdrawal(address indexed token, address indexed to, uint256 amount);
    event NativeWithdrawal(address indexed to, uint256 amount);

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Current holdings of `token`.
    function balanceOf(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice Withdraw `amount` of `token` to `to`.
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Treasury: zero recipient");
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawal(token, to, amount);
    }

    /// @notice Withdraw the entire `token` balance to `to`.
    function withdrawAll(address token, address to) external onlyOwner nonReentrant {
        require(to != address(0), "Treasury: zero recipient");
        uint256 amount = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawal(token, to, amount);
    }

    /// @notice Accept native CELO (e.g. accidental transfers) so it can be rescued.
    receive() external payable {}

    /// @notice Rescue native CELO sent to this contract.
    function withdrawNative(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Treasury: zero recipient");
        (bool ok,) = to.call{value: amount}("");
        require(ok, "Treasury: native transfer failed");
        emit NativeWithdrawal(to, amount);
    }
}
