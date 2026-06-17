// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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
contract Cosmetics is ERC1155, ERC2981, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Item {
        bool exists;
        uint256 price; // primary-sale price in `currency` units (0 = not on primary sale)
        uint256 maxSupply; // 0 = unlimited
        uint256 minted;
    }

    string public name;
    IERC20 public currency; // stablecoin accepted for primary sales
    address public treasury; // receives primary-sale proceeds

    mapping(uint256 => Item) public items;

    event ItemCreated(uint256 indexed id, uint256 price, uint256 maxSupply);
    event ItemPriceUpdated(uint256 indexed id, uint256 price);
    event Purchased(uint256 indexed id, address indexed buyer, uint256 amount, uint256 cost);
    event CurrencyUpdated(address indexed currency);
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
        require(currency_ != address(0) && treasury_ != address(0), "Cosmetics: zero addr");
        name = name_;
        currency = IERC20(currency_);
        treasury = treasury_;
        _setDefaultRoyalty(royaltyReceiver, royaltyBps); // reverts if bps > 100%
    }

    // ------------------------------ catalogue --------------------------- //

    function createItem(uint256 id, uint256 price, uint256 maxSupply) external onlyOwner {
        require(!items[id].exists, "Cosmetics: exists");
        items[id] = Item({exists: true, price: price, maxSupply: maxSupply, minted: 0});
        emit ItemCreated(id, price, maxSupply);
    }

    function setItemPrice(uint256 id, uint256 price) external onlyOwner {
        require(items[id].exists, "Cosmetics: no item");
        items[id].price = price;
        emit ItemPriceUpdated(id, price);
    }

    // -------------------------------- sales ----------------------------- //

    /// @notice Buy `amount` of cosmetic `id`, paying the stablecoin to the Treasury.
    function buy(uint256 id, uint256 amount) external nonReentrant {
        Item storage item = items[id];
        require(item.exists, "Cosmetics: no item");
        require(item.price > 0, "Cosmetics: not for sale");
        require(amount > 0, "Cosmetics: zero amount");
        require(item.maxSupply == 0 || item.minted + amount <= item.maxSupply, "Cosmetics: sold out");

        uint256 cost = item.price * amount;
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

    function setCurrency(address currency_) external onlyOwner {
        require(currency_ != address(0), "Cosmetics: zero addr");
        currency = IERC20(currency_);
        emit CurrencyUpdated(currency_);
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

    // ----------------------------- overrides ---------------------------- //

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
