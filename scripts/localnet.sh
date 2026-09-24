#!/usr/bin/env bash
# Starts a local validator with the launchpad program and a copy of the
# mainnet Raydium CPMM program + accounts (tests/fixtures), so the full
# lifecycle (create -> trade -> graduate to Raydium) works locally.
#
# Usage: scripts/localnet.sh [extra solana-test-validator args]
# Env:   LEDGER (default .anchor/test-ledger), WALLET (default ~/.config/solana/id.json)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LEDGER="${LEDGER:-$ROOT/.anchor/test-ledger}"
WALLET="${WALLET:-$HOME/.config/solana/id.json}"
PROGRAM_SO="$ROOT/target/deploy/launchpad.so"
PROGRAM_ID="$(solana-keygen pubkey "$ROOT/target/deploy/launchpad-keypair.json")"
FIXTURES="$ROOT/tests/fixtures"

[ -f "$PROGRAM_SO" ] || { echo "missing $PROGRAM_SO: run 'anchor build' first" >&2; exit 1; }
[ -f "$WALLET" ] || { echo "missing wallet $WALLET: run 'solana-keygen new'" >&2; exit 1; }

RAYDIUM_CPMM=CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
AMM_CONFIG=D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2
CREATE_POOL_FEE=DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8

mkdir -p "$(dirname "$LEDGER")"
exec solana-test-validator \
  --reset \
  --quiet \
  --ledger "$LEDGER" \
  --limit-ledger-size 50000000 \
  --upgradeable-program "$PROGRAM_ID" "$PROGRAM_SO" "$WALLET" \
  --bpf-program "$RAYDIUM_CPMM" "$FIXTURES/raydium_cpmm.so" \
  --account "$AMM_CONFIG" "$FIXTURES/$AMM_CONFIG.json" \
  --account "$CREATE_POOL_FEE" "$FIXTURES/$CREATE_POOL_FEE.json" \
  "$@"
