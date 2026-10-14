#!/usr/bin/env bash
# Deploys Purser to a public testnet and seeds a small demo account.
#
#   ./scripts/deploy-testnet.sh base-sepolia     # or: sepolia
#
# Reads keys from .env.testnet (gitignored). Fund the deployer address printed below from a
# faucet first; the whole run costs well under 0.01 ETH. With ETHERSCAN_API_KEY set, the
# contracts are verified too.
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK="${1:-base-sepolia}"
case "$NETWORK" in
  base-sepolia) RPC_VAR=BASE_SEPOLIA_RPC_URL; CHAIN_ID=84532; EXPLORER=https://sepolia.basescan.org; ALIAS=base_sepolia ;;
  sepolia) RPC_VAR=SEPOLIA_RPC_URL; CHAIN_ID=11155111; EXPLORER=https://sepolia.etherscan.io; ALIAS=sepolia ;;
  *) echo "unknown network: $NETWORK (base-sepolia or sepolia)"; exit 1 ;;
esac

[ -f .env.testnet ] || { echo "Missing .env.testnet. Copy .env.example to .env.testnet and fill in the keys."; exit 1; }
set -a; source .env.testnet; set +a
RPC="${!RPC_VAR}"

DEPLOYER=$(node -e "console.log(require('viem/accounts').privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY).address)")
AGENT=$(node -e "console.log(require('viem/accounts').privateKeyToAccount(process.env.AGENT_PRIVATE_KEY).address)")
BALANCE=$(node -e "
  const { createPublicClient, http, formatEther } = require('viem');
  createPublicClient({ transport: http('$RPC') }).getBalance({ address: '$DEPLOYER' }).then((b) => console.log(formatEther(b)));")
echo "Network   $NETWORK ($CHAIN_ID)"
echo "Deployer  $DEPLOYER  balance $BALANCE ETH"
echo "Agent     $AGENT"
if node -e "process.exit(Number('$BALANCE') >= 0.008 ? 0 : 1)"; then :; else
  echo
  echo "The deployer needs about 0.008 ETH. Get testnet ETH for $DEPLOYER from a faucet, for example:"
  echo "  https://www.alchemy.com/faucets/base-sepolia"
  echo "  https://cloud.google.com/application/web3/faucet/ethereum/sepolia"
  echo "  https://docs.base.org/chain/network-faucets"
  exit 1
fi

VERIFY=()
[ -n "${ETHERSCAN_API_KEY:-}" ] && VERIFY=(--verify)

if command -v forge >/dev/null 2>&1; then
  run() { (cd contracts && "$@"); }
else
  DIR="$(cd contracts && (pwd -W 2>/dev/null || pwd))"
  run() {
    local tool="$1"; shift
    MSYS_NO_PATHCONV=1 docker run --rm --user root -v "$DIR:/work" -v purser-svm:/root/.svm -w /work \
      -e OWNER_PRIVATE_KEY -e AGENT_ADDRESS -e FUND_ETH_WEI -e ETH_PER_TX_WEI -e ETH_PER_PERIOD_WEI \
      -e ETHERSCAN_API_KEY -e "$RPC_VAR" --entrypoint "$tool" ghcr.io/foundry-rs/foundry:latest "$@"
  }
fi

export OWNER_PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY AGENT_ADDRESS=$AGENT
# Small amounts for faucet ETH: fund the account with 0.005 ETH; the agent may spend
# 0.0005 ETH per payment and 0.001 ETH per day.
export FUND_ETH_WEI=5000000000000000 ETH_PER_TX_WEI=500000000000000 ETH_PER_PERIOD_WEI=1000000000000000

run forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY" "${VERIFY[@]}"
run forge script script/SeedDemo.s.sol --rpc-url "$RPC" --broadcast "${VERIFY[@]}"

ENV_FILE=".env.$NETWORK"
cat > "$ENV_FILE" <<EOF
# Purser server on $NETWORK. Written by scripts/deploy-testnet.sh. Gitignored.
PURSER_RPC_URL=$RPC
PURSER_DEPLOYMENT=contracts/deployments/$CHAIN_ID.demo.json
PURSER_AGENT_PRIVATE_KEY=$AGENT_PRIVATE_KEY
PURSER_RELAYER_PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY
PURSER_OWNER_PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY
PURSER_DEMO=true
PURSER_EXPLORER_URL=$EXPLORER
PURSER_CONSOLE_DIR=apps/console/dist
PURSER_DATA_DIR=.purser-$NETWORK
EOF

echo
echo "Deployed. Addresses: contracts/deployments/$CHAIN_ID.json and $CHAIN_ID.demo.json"
echo "Run the server:  npx tsx --env-file=$ENV_FILE packages/server/src/index.ts"
echo "Run the demo:    DEMO_SCALE=0.01 npm run demo"
