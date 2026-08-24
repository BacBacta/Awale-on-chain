// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Cosmetics — tradeable Awalé board/seed skins (ERC-1155 + ERC-2981)
/// @notice Owned, transferable cosmetic items with on-chain resale royalties.
///         Primary sales are paid in a stablecoin straight to the Treasury;
///         secondary-sale royalties are advertised via ERC-2981.
///
/// @dev Royalties under ERC-2981 are *advisory*: enforcement depends on the
///      marketplace honouring `royaltyInfo`. Primary sales use a single
///      owner-set stablecoin sent directly to the Treasury (no escrow).
///
///      Prices are stored NORMALISED to 18 decimals and scaled into the
///      currency's own units at purchase time. The currency is switchable and
///      the Celo stablecoins do not agree on decimals (USDm 18, USDC/USDT 6),
///      so storing raw base units would mean a single {setCurrency} silently
///      moved every price by 1e12 — a 0.50 item becoming 500,000,000,000.00 in
///      one direction and free in the other. Normalising makes the switch a
///      no-op for what things actually cost.
contract Cosmetics is ERC1155, ERC2981, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Item {
        bool exists;
        uint256 priceE18; // primary-sale price per unit, NORMALISED to 18 dec (0 = not on primary sale)
        uint256 maxSupply; // 0 = unlimited
        uint256 minted;
    }

    string public name;
    IERC20 public currency; // stablecoin accepted for primary sales
    uint8 public currencyDecimals; // decimals() of `currency`, cached for price scaling
    address public treasury; // receives primary-sale proceeds

    mapping(uint256 => Item) public items;

    event ItemCreated(uint256 indexed id, uint256 priceE18, uint256 maxSupply);
    event ItemPriceUpdated(uint256 indexed id, uint256 priceE18);
    event Purchased(uint256 indexed id, address indexed buyer, uint256 amount, uint256 cost);
    event CurrencyUpdated(address indexed currency, uint8 decimals);
    event TreasuryUpdated(address indexed treasury);

    constructor(
        string memory name_,
        string memory uri_,
        address currency_,
        address treasury_,
        address royaltyReceiver,
        uint96 royaltyBps,
        address owner_
    ) ERC1155(uri_) Ownable(owner_) {
        require(treasury_ != address(0), "Cosmetics: zero addr");
        name = name_;
        _setCurrency(currency_);
        treasury = treasury_;
        _setDefaultRoyalty(royaltyReceiver, royaltyBps); // reverts if bps > 100%
    }

    // ------------------------------ catalogue --------------------------- //

    /// @param priceE18 price per unit NORMALISED to 18 decimals (0.5e18 = $0.50),
    ///                 independent of what the current currency's decimals are.
    function createItem(uint256 id, uint256 priceE18, uint256 maxSupply) external onlyOwner {
        require(!items[id].exists, "Cosmetics: exists");
        items[id] = Item({exists: true, priceE18: priceE18, maxSupply: maxSupply, minted: 0});
        emit ItemCreated(id, priceE18, maxSupply);
    }

    /// @param priceE18 price per unit NORMALISED to 18 decimals (see {createItem}).
    function setItemPrice(uint256 id, uint256 priceE18) external onlyOwner {
        require(items[id].exists, "Cosmetics: no item");
        items[id].priceE18 = priceE18;
        emit ItemPriceUpdated(id, priceE18);
    }

    // -------------------------------- sales ----------------------------- //

    /// @notice Buy `amount` of cosmetic `id`, paying the stablecoin to the Treasury.
    /// @param maxCost the most the buyer will pay IN TOTAL, in the current
    ///        currency's base units — pass back the figure {costOf} quoted. This
    ///        binds the purchase to that quote: an owner {setItemPrice} or
    ///        {setCurrency} landing between the quote and this call reverts the
    ///        tx instead of silently charging the new amount against a standing
    ///        allowance. A price CUT still settles, at the lower price.
    function buy(uint256 id, uint256 amount, uint256 maxCost) external nonReentrant {
        Item storage item = items[id];
        require(item.exists, "Cosmetics: no item");
        require(item.priceE18 > 0, "Cosmetics: not for sale");
        require(amount > 0, "Cosmetics: zero amount");
        require(item.maxSupply == 0 || item.minted + amount <= item.maxSupply, "Cosmetics: sold out");

        uint256 cost = _toCurrency(item.priceE18 * amount);
        // a price that scales to nothing in a low-decimal currency must never
        // mint for free — reverting is the safe side of that truncation
        require(cost > 0, "Cosmetics: cost rounds to zero");
        require(cost <= maxCost, "Cosmetics: cost exceeds max");
        item.minted += amount; // effects before interactions

        currency.safeTransferFrom(msg.sender, treasury, cost);
        _mint(msg.sender, id, amount, "");

        emit Purchased(id, msg.sender, amount, cost);
    }

    /// @notice Mint cosmetics without payment (promos / airdrops), supply-capped.
    function ownerMint(address to, uint256 id, uint256 amount) external onlyOwner {
        Item storage item = items[id];
        require(item.exists, "Cosmetics: no item");
        require(item.maxSupply == 0 || item.minted + amount <= item.maxSupply, "Cosmetics: sold out");
        item.minted += amount;
        _mint(to, id, amount, "");
    }

    // -------------------------------- admin ----------------------------- //

    function setURI(string calldata newUri) external onlyOwner {
        _setURI(newUri);
    }

    /// @notice Switch the stablecoin primary sales are paid in. Safe across a
    ///         decimals change: prices are stored normalised, so an item priced
    ///         at 0.5e18 costs $0.50 whether the currency is 18-dec or 6-dec.
    function setCurrency(address currency_) external onlyOwner {
        _setCurrency(currency_);
    }

    /// @dev Point sales at `currency_` and cache its decimals in the same step,
    ///      so the cache can never drift from the token it describes.
    function _setCurrency(address currency_) internal {
        require(currency_ != address(0), "Cosmetics: zero addr");
        uint8 d = IERC20Metadata(currency_).decimals();
        // >18 would need to scale UP, which can overflow a large price; no Celo
        // stablecoin exceeds 18, so reject rather than carry unreachable math
        require(d <= 18, "Cosmetics: decimals > 18");
        currency = IERC20(currency_);
        currencyDecimals = d;
        emit CurrencyUpdated(currency_, d);
    }

    function setTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "Cosmetics: zero addr");
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setDefaultRoyalty(address receiver, uint96 bps) external onlyOwner {
        _setDefaultRoyalty(receiver, bps);
    }

    function setTokenRoyalty(uint256 id, address receiver, uint96 bps) external onlyOwner {
        _setTokenRoyalty(id, receiver, bps);
    }

    // ------------------------------- views ------------------------------ //

    /// @notice What `amount` of item `id` costs right now, in the CURRENT
    ///         currency's base units. The shop reads this rather than scaling the
    ///         stored price itself, so the quoted price and what {buy} actually
    ///         pulls can never disagree.
    function costOf(uint256 id, uint256 amount) external view returns (uint256) {
        return _toCurrency(items[id].priceE18 * amount);
    }

    /// @dev Normalised 18-dec amount → the currency's base units. Truncates, so
    ///      the contract never rounds a price up against the buyer.
    function _toCurrency(uint256 amountE18) internal view returns (uint256) {
        uint8 d = currencyDecimals;
        if (d == 18) return amountE18;
        return amountE18 / (10 ** (18 - d));
    }

    // ----------------------------- overrides ---------------------------- //

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
