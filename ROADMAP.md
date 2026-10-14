# Roadmap

Purser is the spending layer for AI agents: an account that enforces what an agent may pay,
how much and where, with a person in the loop for everything else. This file is the plan; each item
links to an issue you can pick up. There are no dates: items move from Next to Now when someone is
working on them.

## Now

Pay where agents already pay, and close the gaps in the policy.

- **Pay x402 endpoints within the budget.** x402 (HTTP `402 Payment Required`) is becoming the
  standard way agents pay for APIs and data. A `fetch_paid` tool pays in USDC through the account,
  with the session key's ERC-1271 signatures held to the same caps, budgets and allow-list.
- **Restrict ERC-20 recipients.** Allowing `transfer` on a token lets the agent send it to anyone
  within the budget. Add an optional recipient allow-list per token.
- **Gas budget per key.** Operations pay gas from the account, including failed ones. Cap the gas a
  session key can spend per period.
- **Expire approval requests** after a configurable time, so an old request cannot be approved
  days later by mistake.
- **`simulate_payment` MCP tool.** A dry run the agent can use to check a payment before asking.
- **Wallet discovery in the console** (EIP-6963), so owners can approve with any browser wallet.

## Next

- **Paymaster.** Sponsor agent gas from a separate budget, so the account balance is only for
  payments.
- **EIP-7702.** Let an existing EOA delegate to Purser and keep its address.
- **ERC-7579 module.** Ship the session-key policy as a validator and hook module for modular
  accounts (Safe, Kernel, Nexus).
- **ERC-7715.** Let an agent request a session key and budget, and the owner grant it from their
  own wallet.
- **Grant keys from the console**, with the policy as a form and a preview of what it allows.
- **Notifications** for approval requests: webhook, Slack and Telegram.
- **More spend accounting**: Permit2, `increaseAllowance`, and native-token wrappers.
- **Bundlers**: tested setup with a hosted bundler on Base Sepolia, documented.
- **More networks**: Arbitrum Sepolia and Optimism Sepolia deployments.

## Later

- **USD budgets** with a price feed, so one budget covers several tokens.
- **Multi-agent views** in the console: filter activity per agent, compare spend.
- **Formal checks**: a Medusa or Echidna campaign next to the Foundry invariants, and Halmos for the
  core properties.
- **An audit** before anyone is encouraged to hold real value.

## Not planned

- Holding the owner key in the server outside demo mode. Owners sign in their own wallet.
- A custodial service. Purser is software you run.
- Agent frameworks of its own. Agents connect over MCP or the SDK.

## How to help

Pick an issue labelled `good first issue` or `help wanted`, comment that you are taking it, and
read [CONTRIBUTING.md](./CONTRIBUTING.md). For ideas and questions, use
[Discussions](https://github.com/ahmad-codex/purser/discussions).
