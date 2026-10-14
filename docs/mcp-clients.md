# Connecting MCP clients

The server speaks MCP over streamable HTTP at `/mcp`, and over stdio with `--stdio`. Every tool
acts as the agent's session key; the owner key is never exposed to the client.

## Claude Code

```bash
claude mcp add --transport http purser http://localhost:8787/mcp
```

## Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "purser": { "url": "http://localhost:8787/mcp" }
  }
}
```

## Claude Desktop (stdio)

Claude Desktop starts the server itself. Use the same settings as `.env.local`, as absolute paths:

```json
{
  "mcpServers": {
    "purser": {
      "command": "npx",
      "args": ["tsx", "C:/path/to/purser/packages/server/src/index.ts", "--stdio"],
      "env": {
        "PURSER_RPC_URL": "http://127.0.0.1:8545",
        "PURSER_DEPLOYMENT": "C:/path/to/purser/contracts/deployments/31337.demo.json",
        "PURSER_AGENT_PRIVATE_KEY": "0x...",
        "PURSER_RELAYER_PRIVATE_KEY": "0x...",
        "PURSER_DATA_DIR": "C:/path/to/purser/.purser"
      }
    }
  }
}
```

In stdio mode there is no console. Run `npm run server` alongside it with the same
`PURSER_DATA_DIR` to approve requests in the browser: both read the same request store.

## Prompts to try

- "What is my wallet status?"
- "Pay the merchant 0.01 ETH for API credits."
- "Send 20 dUSD to the merchant for the monthly subscription."
- "Buy item 3 from the shop for 0.02 ETH."
- "Pay the merchant 0.5 ETH." (over the limit: watch the approval appear in the console, approve
  it, then ask the agent to check the request)

The server's instructions tell the model to call `wallet_status` first and never to split a
payment to get around a limit.
