// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MatchEscrow} from "../src/MatchEscrow.sol";
import {ReplayVerifier} from "../src/ReplayVerifier.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev Random-walks the full escrow lifecycle across many concurrent matches
///      and four players: create → join → (finalizeStart) → one of
///      {settleSigned, proposeResult→finalize, voidExpired, cancelMatch}, plus
///      owner rake changes and time warps. All money movement is tracked with
///      DELTA-based ghosts (measure the escrow/treasury balance change around
///      each call), so the ghosts are exact and path-agnostic — and, because
///      the default invariant config discards reverting handler calls, every
///      correctness claim is expressed as an invariant (checked between calls),
///      never as a handler-internal assert.
///
///      The `challenge` path is intentionally omitted here: building a signed,
///      terminating transcript for a random match's random startTurn is what the
///      dedicated ReplayVerifier/MatchEscrow unit tests cover, and its money
///      effects run through the SAME `_payout`/`_void` internals these actions
///      already exercise.
contract EscrowHandler is Test {
    MatchEscrow public escrow;
    MockERC20 public usdc;
    address public treasury;
    address public owner;

    uint256 internal pk0 = 0xA11CE;
    uint256 internal pk1 = 0xB0B;
    address internal session0;
    address internal session1;

    address[4] public players;

    uint256[] public ids; // every created match id
    uint256 internal constant MAX_MATCHES = 32; // cap so per-invariant scans stay cheap

    // delta-based money ghosts (all in token units)
    uint256 public ghostIn; // total ever transferred INTO escrow (stakes)
    uint256 public ghostOut; // total ever transferred OUT of escrow (payouts + refunds + rake)
    uint256 public ghostRake; // total ever routed to the treasury

    constructor(MatchEscrow e, MockERC20 t, address treasury_, address owner_) {
        escrow = e;
        usdc = t;
        treasury = treasury_;
        owner = owner_;
        session0 = vm.addr(pk0);
        session1 = vm.addr(pk1);
        for (uint256 i; i < 4; i++) {
            address who = address(uint160(0xA11CE0 + i));
            players[i] = who;
            usdc.mint(who, 1_000_000_000_000); // 1M USDC (6-dec) — never the binding constraint
            vm.prank(who);
            usdc.approve(address(escrow), type(uint256).max);
        }
    }

    // ------------------------------ helpers ----------------------------- //

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    /// First id (scanning from a random offset) whose status matches `want`, or
    /// type(uint256).max if none exists.
    function _pick(uint256 seed, MatchEscrow.Status want) internal view returns (uint256) {
        uint256 n = ids.length;
        if (n == 0) return type(uint256).max;
        uint256 start = seed % n;
        for (uint256 k; k < n; k++) {
            uint256 id = ids[(start + k) % n];
            if (escrow.getMatch(id).status == want) return id;
        }
        return type(uint256).max;
    }

    // ------------------------------ actions ----------------------------- //

    function create(uint256 who, uint256 amount) external {
        if (ids.length >= MAX_MATCHES) return;
        address p = players[who % 4];
        uint128 stake = uint128(bound(amount, 1, 100_000_000)); // up to 100 USDC
        uint256 eb = usdc.balanceOf(address(escrow));
        vm.prank(p);
        uint256 id = escrow.createMatch(address(usdc), stake, session0);
        ids.push(id);
        ghostIn += usdc.balanceOf(address(escrow)) - eb;
    }

    function join(uint256 seed, uint256 who) external {
        uint256 id = _pick(seed, MatchEscrow.Status.Open);
        if (id == type(uint256).max) return;
        address joiner = players[who % 4];
        if (joiner == escrow.getMatch(id).player0) joiner = players[(who + 1) % 4];
        uint256 eb = usdc.balanceOf(address(escrow));
        vm.prank(joiner);
        escrow.joinMatch(id, session1);
        ghostIn += usdc.balanceOf(address(escrow)) - eb;
        // fix the first-move flip so the propose/finalize path is reachable
        vm.roll(block.number + uint256(escrow.START_REVEAL_DELAY()) + 1);
        try escrow.finalizeStart(id) {} catch {}
    }

    function settleSigned(uint256 seed, uint8 winner) external {
        uint256 id = _pick(seed, MatchEscrow.Status.Active);
        if (id == type(uint256).max) return;
        uint8 w = winner % 3;
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(pk0, escrow.resultDigest(id, w));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(pk1, escrow.resultDigest(id, w));
        _resolveMeasured(id, abi.encodeCall(escrow.settleSigned, (id, w, abi.encodePacked(r0, s0, v0), abi.encodePacked(r1, s1, v1))));
    }

    function proposeAndMaybeFinalize(uint256 seed, uint8 winner, uint256 dt) external {
        uint256 id = _pick(seed, MatchEscrow.Status.Active);
        if (id == type(uint256).max) return;
        MatchEscrow.Match memory m = escrow.getMatch(id);
        if (m.startTurn == type(uint8).max) return; // start not fixed yet
        uint8 w = winner % 3;
        // prank an ACTUAL participant (proposeResult is player-gated); do the
        // window-length read BEFORE the prank so it isn't consumed by the prank
        uint256 window = m.challengeWindow;
        address proposer = (seed & 1) == 0 ? m.player0 : m.player1;
        vm.prank(proposer);
        try escrow.proposeResult(id, w, keccak256(abi.encode(id, w, "commit"))) {} catch { return; }
        // let the challenge window elapse, then finalize the proposed winner
        vm.warp(block.timestamp + bound(dt, window + 1, window + 2 days));
        _resolveMeasured(id, abi.encodeCall(escrow.finalize, (id)));
    }

    function voidExpired(uint256 seed, uint256 dt) external {
        // any live status is voidable once past its deadline
        uint256 id = _pick(seed, MatchEscrow.Status.Active);
        if (id == type(uint256).max) id = _pick(seed, MatchEscrow.Status.Open);
        if (id == type(uint256).max) id = _pick(seed, MatchEscrow.Status.Proposed);
        if (id == type(uint256).max) return;
        uint64 dl = escrow.getMatch(id).activeDeadline;
        if (dl == 0) return;
        vm.warp(uint256(dl) + bound(dt, 1, 2 days));
        _resolveMeasured(id, abi.encodeCall(escrow.voidExpired, (id)));
    }

    function cancel(uint256 seed) external {
        uint256 id = _pick(seed, MatchEscrow.Status.Open);
        if (id == type(uint256).max) return;
        // cancelMatch is creator-gated: measure balances FIRST (external reads
        // would otherwise consume the prank), then prank immediately before it.
        address creator = escrow.getMatch(id).player0;
        uint256 eb = usdc.balanceOf(address(escrow));
        uint256 tb = usdc.balanceOf(treasury);
        vm.prank(creator);
        escrow.cancelMatch(id);
        ghostOut += eb - usdc.balanceOf(address(escrow));
        ghostRake += usdc.balanceOf(treasury) - tb;
    }

    function setRake(uint16 r) external {
        // bind (an external MAX read) BEFORE the prank, or the prank is consumed
        // and setRake runs as a non-owner and reverts (silently discarded)
        uint16 capped = uint16(bound(r, 0, escrow.MAX_RAKE_BPS()));
        vm.prank(owner);
        escrow.setRake(capped);
    }

    function warpAhead(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 1 days));
    }

    // -------------------------- measured resolve ------------------------ //

    /// Call a payout/refund path and fold the exact balance deltas into ghosts.
    /// If the low-level call reverts, the whole handler invocation is discarded
    /// by the fuzzer, so the ghosts only ever advance on a real settlement.
    function _resolveMeasured(uint256, bytes memory data) internal {
        uint256 eb = usdc.balanceOf(address(escrow));
        uint256 tb = usdc.balanceOf(treasury);
        (bool ok,) = address(escrow).call(data);
        require(ok, "resolve reverted"); // discards this fuzz call
        ghostOut += eb - usdc.balanceOf(address(escrow));
        ghostRake += usdc.balanceOf(treasury) - tb;
    }

    /// Sum of stakes the escrow still owes to LIVE matches:
    /// Open = one stake (creator), Active/Proposed = two (both players).
    function lockedObligations() external view returns (uint256 locked) {
        uint256 n = ids.length;
        for (uint256 i; i < n; i++) {
            MatchEscrow.Match memory m = escrow.getMatch(ids[i]);
            if (m.status == MatchEscrow.Status.Open) locked += m.stake;
            else if (m.status == MatchEscrow.Status.Active || m.status == MatchEscrow.Status.Proposed) {
                locked += uint256(m.stake) * 2;
            }
        }
    }
}

contract MatchEscrowInvariantTest is Test {
    MatchEscrow internal escrow;
    ReplayVerifier internal verifier;
    MockERC20 internal usdc;
    EscrowHandler internal handler;

    address internal owner = address(0x0E1);
    address internal treasury = address(0x7EA);

    uint16 internal constant RAKE_BPS = 1100; // 11%, the deployed rake
    uint64 internal constant WINDOW = 600;
    uint64 internal constant TTL = 1 days;

    function setUp() public {
        verifier = new ReplayVerifier();
        escrow = new MatchEscrow(address(verifier), treasury, RAKE_BPS, WINDOW, TTL, owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        vm.prank(owner);
        escrow.setTokenAllowed(address(usdc), true);

        handler = new EscrowHandler(escrow, usdc, treasury, owner);
        targetContract(address(handler));
    }

    /// SOLVENCY — the keystone. The escrow's token balance is at all times
    /// exactly the stakes it still owes to live matches. Any stuck dust (a match
    /// that under-paid) would push balance above this; any over-pay would push it
    /// below (and the next real transfer would revert). Proving equality proves
    /// every closed match disbursed its stakes in full, and every open one is
    /// fully backed.
    function invariant_escrowExactlyBacksLiveMatches() public view {
        assertEq(usdc.balanceOf(address(escrow)), handler.lockedObligations(), "escrow balance != live obligations");
    }

    /// CONSERVATION — double-entry. Every token that entered the escrow is either
    /// still held or has left; nothing is minted or destroyed by the contract.
    function invariant_conservation() public view {
        assertEq(handler.ghostIn(), usdc.balanceOf(address(escrow)) + handler.ghostOut(), "tokens leaked");
    }

    /// TREASURY — the only non-player recipient. Its balance equals exactly the
    /// rake the escrow has ever routed to it (delta-measured), and never more.
    function invariant_treasuryHoldsExactlyRake() public view {
        assertEq(usdc.balanceOf(treasury), handler.ghostRake(), "treasury balance != cumulative rake");
    }

    /// RAKE BOUND — the house can never skim more than the hard cap of everything
    /// staked: sum(rake) ≤ MAX_RAKE_BPS/BPS of total stakes in. (Each match's rake
    /// is ≤ pot·MAX/BPS and every pot is a disjoint slice of ghostIn.)
    function invariant_rakeNeverExceedsCap() public view {
        assertLe(
            handler.ghostRake() * escrow.BPS(),
            handler.ghostIn() * escrow.MAX_RAKE_BPS(),
            "cumulative rake exceeds the cap"
        );
    }
}
