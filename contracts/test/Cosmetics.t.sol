// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Cosmetics} from "../src/Cosmetics.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract CosmeticsTest is Test {
    Cosmetics internal cosmetics;
    MockERC20 internal usdc;

    address internal owner = address(0x0E1);
    address internal treasury = address(0x7EA);
    address internal alice = address(0xA1);

    uint96 internal constant ROYALTY_BPS = 500; // 5%
    uint256 internal constant BOARD = 1;
    uint256 internal constant PRICE = 5e6; // 5 USDC

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        cosmetics = new Cosmetics(
            "Awale Cosmetics", "ipfs://base/{id}.json", address(usdc), treasury, treasury, ROYALTY_BPS, owner
        );
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(cosmetics), type(uint256).max);

        vm.prank(owner);
        cosmetics.createItem(BOARD, PRICE, 100); // maxSupply 100
    }

    function test_buy_paysTreasuryAndMints() public {
        vm.prank(alice);
        cosmetics.buy(BOARD, 3);

        assertEq(cosmetics.balanceOf(alice, BOARD), 3);
        assertEq(usdc.balanceOf(treasury), PRICE * 3, "proceeds to treasury");
        (,, uint256 maxSupply, uint256 minted) = cosmetics.items(BOARD);
        assertEq(minted, 3);
        assertEq(maxSupply, 100);
    }

    function test_buy_revertSoldOut() public {
        vm.prank(alice);
        vm.expectRevert(bytes("Cosmetics: sold out"));
        cosmetics.buy(BOARD, 101);
    }

    function test_buy_revertNotForSale() public {
        vm.prank(owner);
        cosmetics.createItem(2, 0, 0); // price 0 = not on primary sale
        vm.prank(alice);
        vm.expectRevert(bytes("Cosmetics: not for sale"));
        cosmetics.buy(2, 1);
    }

    function test_buy_revertNoItem() public {
        vm.prank(alice);
        vm.expectRevert(bytes("Cosmetics: no item"));
        cosmetics.buy(999, 1);
    }

    function test_createItem_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        cosmetics.createItem(5, PRICE, 0);
    }

    function test_createItem_revertDuplicate() public {
        vm.prank(owner);
        vm.expectRevert(bytes("Cosmetics: exists"));
        cosmetics.createItem(BOARD, PRICE, 0);
    }

    function test_ownerMint_airdrop() public {
        vm.prank(owner);
        cosmetics.ownerMint(alice, BOARD, 2);
        assertEq(cosmetics.balanceOf(alice, BOARD), 2);
        assertEq(usdc.balanceOf(treasury), 0, "no payment on airdrop");
    }

    function test_ownerMint_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        cosmetics.ownerMint(alice, BOARD, 1);
    }

    function test_royaltyInfo() public view {
        (address receiver, uint256 amount) = cosmetics.royaltyInfo(BOARD, 1_000e6);
        assertEq(receiver, treasury);
        assertEq(amount, (1_000e6 * ROYALTY_BPS) / 10_000, "5% royalty");
    }

    function test_perTokenRoyaltyOverride() public {
        vm.prank(owner);
        cosmetics.setTokenRoyalty(BOARD, alice, 1000); // 10% to alice for this id
        (address receiver, uint256 amount) = cosmetics.royaltyInfo(BOARD, 1_000e6);
        assertEq(receiver, alice);
        assertEq(amount, (1_000e6 * 1000) / 10_000);
    }

    function test_supportsInterface() public view {
        assertTrue(cosmetics.supportsInterface(0xd9b67a26), "ERC1155");
        assertTrue(cosmetics.supportsInterface(0x2a55205a), "ERC2981");
        assertTrue(cosmetics.supportsInterface(0x01ffc9a7), "ERC165");
    }

    function test_setTreasury_redirectsProceeds() public {
        address newTreasury = address(0xBEEF);
        vm.prank(owner);
        cosmetics.setTreasury(newTreasury);
        vm.prank(alice);
        cosmetics.buy(BOARD, 1);
        assertEq(usdc.balanceOf(newTreasury), PRICE);
    }
}
