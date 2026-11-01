# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-11-01

### Added

- Listing in the official MCP Registry as `io.github.ahmad-codex/purser`: `server.json`, the
  `io.modelcontextprotocol.server.name` label on the server image, and a workflow that publishes
  after each release image.

## [0.1.1] - 2026-10-24

### Added

- MCP tool annotations: `wallet_status`, `get_request` and `list_requests` are read-only; `send_eth`,
  `send_token` and `call_contract` are marked destructive and not idempotent, so hosts can confirm a
  payment before it runs.
- Tests that call every MCP tool through an in-memory client.

## [0.1.0] - 2026-10-20

### Added

- `PurserAccount`: ERC-4337 v0.7 account with an owner and session keys. Each key has an allow-list of
  `(contract, function)` pairs, per-transaction caps and per-period budgets for ETH and ERC-20
  tokens, and a validity window. Over-limit operations run with the owner's co-signature. Revoke,
  freeze, ERC-1271, UUPS upgrades by the owner.
- `PurserFactory`: CREATE2 factory for ERC-1967 proxies.
- Foundry tests: unit tests through a real EntryPoint, fuzz tests against a budget model, and
  invariant tests for budgets, revocation and policy integrity. Slither configuration.
- Deploy script with a deterministic factory address, and a demo seed script.
- `@purser/sdk`: viem client that builds, signs and submits user operations through a bundler
  or `handleOps`, decodes policy errors, and reads state and events within public RPC log limits.
- `@purser/server`: MCP server (streamable HTTP and stdio) with `wallet_status`, `send_eth`,
  `send_token`, `call_contract`, `get_request` and `list_requests`, an approvals API, and the
  console.
- Console: balances, per-agent budget meters, approvals, activity, revoke and freeze.
- `ghcr.io/ahmad-codex/purser:demo`: one `docker run` starts a chain, deploys, seeds an agent, serves the console and plays the demo story.
- `docker compose up` for a local chain with a seeded demo, `scripts/demo.ts` end-to-end demo,
  `scripts/deploy-testnet.sh` for Base Sepolia and Sepolia.

[Unreleased]: https://github.com/ahmad-codex/purser/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/ahmad-codex/purser/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ahmad-codex/purser/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ahmad-codex/purser/releases/tag/v0.1.0
