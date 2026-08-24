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
    // Prices are stored NORMALISED to 18 dec; PRICE_USDC is what that is worth
    // in the 6-dec test currency, which is what the treasury actually receives.
    uint256 internal constant PRICE_E18 = 5e18; // $5, currency-independent
    uint256 internal constant PRICE_USDC = 5e6; // $5 in the 6-dec currency

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        cosmetics = new Cosmetics(
            "Awale Cosmetics", "ipfs://base/{id}.json", address(usdc), treasury, treasury, ROYALTY_BPS, owner
        );
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(cosmetics), type(uint256).max);

        vm.prank(owner);
        cosmetics.createItem(BOARD, PRICE_E18, 100); // maxSupply 100
    }

    function test_buy_paysTreasuryAndMints() public {
        vm.prank(alice);
        cosmetics.buy(BOARD, 3);

        assertEq(cosmetics.balanceOf(alice, BOARD), 3);
        assertEq(usdc.balanceOf(treasury), PRICE_USDC * 3, "proceeds to treasury");
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
        cosmetics.createItem(5, PRICE_E18, 0);
    }

    function test_createItem_revertDuplicate() public {
        vm.prank(owner);
        vm.expectRevert(bytes("Cosmetics: exists"));
        cosmetics.createItem(BOARD, PRICE_E18, 0);
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
        assertEq(usdc.balanceOf(newTreasury), PRICE_USDC);
    }

    // ------------------------ currency decimals -------------------------- //

    /// Regression: prices used to be stored in the currency's own base units, so
    /// a single {setCurrency} between a 6-dec and an 18-dec stablecoin moved
    /// every price by 1e12 — a $5 skin becoming $5,000,000,000,000 one way and
    /// free the other — without anyone touching setItemPrice. Normalised storage
    /// means the switch changes the units the buyer pays in, never the price.
    function test_setCurrency_acrossDecimals_keepsRealPrice() public {
        assertEq(cosmetics.costOf(BOARD, 1), PRICE_USDC, "baseline: $5 in 6-dec units");

        MockERC20 usdm = new MockERC20("Mento Dollar", "USDm", 18);
        vm.prank(owner);
        cosmetics.setCurrency(address(usdm));
        assertEq(cosmetics.currencyDecimals(), 18);

        // same $5 — now denominated in 18 decimals, not 1e12 times larger
        assertEq(cosmetics.costOf(BOARD, 1), PRICE_E18);

        usdm.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        usdm.approve(address(cosmetics), type(uint256).max);
        cosmetics.buy(BOARD, 2);
        vm.stopPrank();

        assertEq(usdm.balanceOf(treasury), 10 ether, "$10 for two, in USDm units");
        assertEq(cosmetics.balanceOf(alice, BOARD), 2);
    }

    function test_costOf_scalesWithAmount() public view {
        assertEq(cosmetics.costOf(BOARD, 3), PRICE_USDC * 3);
    }

    /// A price finer than the currency can represent must revert, not truncate
    /// to zero and hand out a free mint.
    function test_buy_revertWhenPriceTruncatesToZero() public {
        vm.prank(owner);
        cosmetics.createItem(42, 1e9, 0); // 1e-9 of a dollar — under 6-dec resolution
        assertEq(cosmetics.costOf(42, 1), 0);

        vm.prank(alice);
        vm.expectRevert(bytes("Cosmetics: cost rounds to zero"));
        cosmetics.buy(42, 1);
    }

    /// Scaling UP would be needed above 18 decimals and can overflow a large
    /// price; no Celo stablecoin is above 18, so the currency is rejected.
    function test_setCurrency_rejectsAboveEighteenDecimals() public {
        MockERC20 weird = new MockERC20("Weird", "WRD", 24);
        vm.prank(owner);
        vm.expectRevert(bytes("Cosmetics: decimals > 18"));
        cosmetics.setCurrency(address(weird));
    }
}
