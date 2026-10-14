# Deployments

## Addresses

The factory is deployed through the deterministic CREATE2 proxy
(`0x4e59b44847b379578588920cA78FbF26c0B4956C`) against the canonical EntryPoint v0.7
(`0x0000000071727De22E5E9d8BAf0edAc6f37da032`), so it has the same address on every chain that
has both.

| Network | Chain id | PurserFactory | PurserAccount implementation |
|---|---|---|---|
| Base Sepolia | 84532 | not deployed yet | not deployed yet |
| Ethereum Sepolia | 11155111 | not deployed yet | not deployed yet |

`contracts/deployments/<chainId>.json` records the addresses after a deploy.

## Deploying to a testnet

1. Create `.env.testnet` from the keys section of `.env.example`, or keep the one
   `scripts/deploy-testnet.sh` tells you to create:

   ```
   DEPLOYER_PRIVATE_KEY=0x...      # pays for the deploy and, later, for bundling
   AGENT_PRIVATE_KEY=0x...         # the demo agent's session key
   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
   SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
   ETHERSCAN_API_KEY=              # optional, verifies the contracts
   ```

   Generate fresh keys for this; never reuse a key that has held real funds.

2. Get testnet ETH for the deployer address from a faucet, for example the
   [Alchemy Base Sepolia faucet](https://www.alchemy.com/faucets/base-sepolia) or
   [Base's list of faucets](https://docs.base.org/chain/network-faucets). The deploy itself costs
   well under 0.001 ETH on Base Sepolia; the script also funds the demo account with 0.005 ETH.

3. Deploy, seed a demo account and write `.env.base-sepolia`:

   ```bash
   ./scripts/deploy-testnet.sh base-sepolia
   ```

4. Run the server and the demo against it:

   ```bash
   npm run build -w @purser/console
   npx tsx --env-file=.env.base-sepolia packages/server/src/index.ts
   DEMO_SCALE=0.01 npm run demo
   ```

   `DEMO_SCALE=0.01` runs the same story with 1% of the ETH amounts, matching the smaller budget
   the testnet seed sets (0.0005 ETH per payment, 0.001 ETH per day).

## Rehearsing on a fork

To check a deploy without spending anything, fork the network with Anvil and deploy to the fork:

```bash
anvil --fork-url https://sepolia.base.org --port 8546
cast rpc --rpc-url http://127.0.0.1:8546 anvil_setBalance <deployer> 0x8AC7230489E80000
cd contracts
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8546 --broadcast --private-key <key>
```

The fork has the real canonical EntryPoint, so the whole demo runs against it unchanged.
