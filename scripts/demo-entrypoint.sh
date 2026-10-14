#!/bin/sh
# Entry point of the all-in-one demo image (Dockerfile.demo). Development keys only.
#
#   PURSER_AUTOPLAY=false   start without playing the agent story
#   DEMO_PACE_MS=2500             pause between story steps
set -eu

OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export AGENT_ADDRESS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
export OWNER_PRIVATE_KEY=$OWNER_KEY
export PURSER_RPC_URL=http://127.0.0.1:8545
export PURSER_DEPLOYMENT=/contracts/deployments/31337.demo.json
export PURSER_OWNER_PRIVATE_KEY=$OWNER_KEY
export PURSER_RELAYER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
export PURSER_AGENT_PRIVATE_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

anvil --host 0.0.0.0 --silent &
until cast chain-id --rpc-url "$PURSER_RPC_URL" >/dev/null 2>&1; do sleep 0.2; done

echo "Deploying the EntryPoint, the factory and a demo account..."
cd /contracts
forge script script/Deploy.s.sol --rpc-url "$PURSER_RPC_URL" --broadcast --private-key "$OWNER_KEY" >/dev/null
forge script script/SeedDemo.s.sol --rpc-url "$PURSER_RPC_URL" --broadcast >/dev/null

cd /app
node_modules/.bin/tsx packages/server/src/index.ts >/tmp/server.log 2>&1 &
server=$!
until node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; do
  kill -0 "$server" 2>/dev/null || { cat /tmp/server.log; exit 1; }
  sleep 0.3
done

cat <<'EOF'

  Purser is running.

    Console   http://localhost:8787
    MCP       http://localhost:8787/mcp
              claude mcp add --transport http purser http://localhost:8787/mcp

EOF

if [ "${PURSER_AUTOPLAY:-true}" = "true" ]; then
  echo "  Open the console now. The agent story starts in 10 seconds..."
  sleep 10
  DEMO_PACE_MS="${DEMO_PACE_MS:-2500}" node_modules/.bin/tsx scripts/demo.ts || true
  echo
  echo "  The wallet stays up: connect your own agent, or press Ctrl+C to stop."
fi

wait "$server"
