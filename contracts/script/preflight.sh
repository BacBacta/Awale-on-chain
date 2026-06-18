#!/usr/bin/env bash
# Pre-deployment checks for the Awalé core. Verifies the RPC, the deployer
# balance, and (unless deploying mock tokens) that the configured stablecoin
# addresses are real contracts — so `forge script Deploy` doesn't fail midway.
#
# Usage:  cd contracts && ./script/preflight.sh
# Reads contracts/.env if present.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
[ -f .env ] && set -a && . ./.env && set +a

RPC="${CELO_SEPOLIA_RPC:-https://forno.celo-sepolia.celo-testnet.org}"
fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

command -v cast >/dev/null || { echo "cast not found — install Foundry"; exit 1; }

echo "RPC: $RPC"
CHAIN_ID=$(cast chain-id --rpc-url "$RPC" 2>/dev/null)
if [ -n "$CHAIN_ID" ]; then ok "RPC reachable (chainId $CHAIN_ID)"; else bad "RPC did not respond"; fi

# Deployer key + balance
if [ -n "${PRIVATE_KEY:-}" ]; then
  DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null)
  if [ -n "$DEPLOYER" ]; then
    BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC" 2>/dev/null || echo 0)
    if [ "${BAL:-0}" != "0" ]; then
      ok "deployer $DEPLOYER funded ($(cast from-wei "$BAL") CELO)"
    else
      bad "deployer $DEPLOYER has 0 CELO — fund it at https://faucet.celo.org"
    fi
  else
    bad "PRIVATE_KEY is not a valid key"
  fi
else
  bad "PRIVATE_KEY is not set"
fi

# Celoscan key (verification)
[ -n "${ETHERSCAN_API_KEY:-}" ] && ok "Celoscan API key set" || warn "ETHERSCAN_API_KEY unset — contract verification will be skipped"

# Token addresses (only when not deploying mocks)
if [ "${DEPLOY_MOCK_TOKENS:-false}" = "true" ]; then
  ok "DEPLOY_MOCK_TOKENS=true — mock stablecoins will be deployed (no token addresses needed)"
else
  for name in USDM_ADDRESS USDC_ADDRESS USDT_ADDRESS; do
    addr="${!name:-}"
    if [ -z "$addr" ]; then
      bad "$name unset (set it, or use DEPLOY_MOCK_TOKENS=true)"
      continue
    fi
    code=$(cast code "$addr" --rpc-url "$RPC" 2>/dev/null)
    if [ -n "$code" ] && [ "$code" != "0x" ]; then ok "$name $addr is a contract"; else bad "$name $addr has no code on this chain"; fi
  done
fi

echo
if [ "$fail" = "0" ]; then
  printf '\033[32mPreflight passed — ready to deploy.\033[0m\n'
else
  printf '\033[31mPreflight found issues — fix the ✗ above before deploying.\033[0m\n'; exit 1
fi
