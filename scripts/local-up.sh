#!/usr/bin/env bash
# Starts a local chain, deploys Purser, seeds a demo account and writes .env.local.
# Uses local Foundry if installed, otherwise the official Foundry Docker image.
#
#   ./scripts/local-up.sh            then   npm run server
set -euo pipefail
cd "$(dirname "$0")/.."

# Anvil's well-known development keys. Never use them anywhere real.
OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
RELAYER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
AGENT_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
AGENT_ADDRESS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

if command -v forge >/dev/null 2>&1; then
  RPC=http://127.0.0.1:8545
  if ! cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
    anvil --silent &
    sleep 2
  fi
  run() { (cd contracts && "$@"); }
else
  RPC=http://host.docker.internal:8545
  if ! docker ps --format '{{.Names}}' | grep -q '^purser-anvil$'; then
    docker rm -f purser-anvil >/dev/null 2>&1 || true
    MSYS_NO_PATHCONV=1 docker run -d --name purser-anvil -p 8545:8545 --entrypoint anvil \
      ghcr.io/foundry-rs/foundry:latest --host 0.0.0.0 >/dev/null
    sleep 3
  fi
  DIR="$(cd contracts && (pwd -W 2>/dev/null || pwd))"
  run() {
    local tool="$1"; shift
    MSYS_NO_PATHCONV=1 docker run --rm --user root -v "$DIR:/work" -v purser-svm:/root/.svm -w /work \
      -e OWNER_PRIVATE_KEY -e AGENT_ADDRESS --entrypoint "$tool" ghcr.io/foundry-rs/foundry:latest "$@"
  }
fi

export OWNER_PRIVATE_KEY=$OWNER_KEY AGENT_ADDRESS
run forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --private-key "$OWNER_KEY" >/dev/null
run forge script script/SeedDemo.s.sol --rpc-url "$RPC" --broadcast >/dev/null

cat > .env.local <<EOF
# Written by scripts/local-up.sh for the local Anvil chain. Development keys only.
PURSER_RPC_URL=http://127.0.0.1:8545
PURSER_DEPLOYMENT=contracts/deployments/31337.demo.json
PURSER_AGENT_PRIVATE_KEY=$AGENT_KEY
PURSER_RELAYER_PRIVATE_KEY=$RELAYER_KEY
PURSER_OWNER_PRIVATE_KEY=$OWNER_KEY
PURSER_DEMO=true
PURSER_CONSOLE_DIR=apps/console/dist
EOF

echo "Local chain ready:"
cat contracts/deployments/31337.demo.json
echo
echo "Next: npm run server   (console on http://localhost:8787, MCP on http://localhost:8787/mcp)"
