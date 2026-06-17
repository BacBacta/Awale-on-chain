// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract TreasuryTest is Test {
    Treasury internal treasury;
    MockERC20 internal usdc;

    address internal owner = address(0x0E1);
    address internal gov = address(0x60A);
    address internal alice = address(0xA1);

    function setUp() public {
        treasury = new Treasury(owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        // simulate rake arriving as a plain transfer
        usdc.mint(address(treasury), 1_000_000);
    }

    function test_balanceOf() public view {
        assertEq(treasury.balanceOf(address(usdc)), 1_000_000);
    }

    function test_withdraw_byOwner() public {
        vm.prank(owner);
        treasury.withdraw(address(usdc), gov, 400_000);
        assertEq(usdc.balanceOf(gov), 400_000);
        assertEq(treasury.balanceOf(address(usdc)), 600_000);
    }

    function test_withdrawAll_drains() public {
        vm.prank(owner);
        treasury.withdrawAll(address(usdc), gov);
        assertEq(usdc.balanceOf(gov), 1_000_000);
        assertEq(treasury.balanceOf(address(usdc)), 0);
    }

    function test_withdraw_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        treasury.withdraw(address(usdc), alice, 1);
    }

    function test_withdraw_revertZeroRecipient() public {
        vm.prank(owner);
        vm.expectRevert(bytes("Treasury: zero recipient"));
        treasury.withdraw(address(usdc), address(0), 1);
    }

    function test_withdraw_revertInsufficient() public {
        vm.prank(owner);
        vm.expectRevert(); // SafeERC20 reverts on insufficient balance
        treasury.withdraw(address(usdc), gov, 2_000_000);
    }

    function test_nativeRescue() public {
        vm.deal(address(this), 5 ether);
        (bool ok,) = address(treasury).call{value: 3 ether}("");
        assertTrue(ok, "treasury accepts native");
        assertEq(address(treasury).balance, 3 ether);

        vm.prank(owner);
        treasury.withdrawNative(gov, 3 ether);
        assertEq(gov.balance, 3 ether);
        assertEq(address(treasury).balance, 0);
    }

    function test_withdrawNative_onlyOwner() public {
        vm.deal(address(treasury), 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        treasury.withdrawNative(alice, 1 ether);
    }
}
