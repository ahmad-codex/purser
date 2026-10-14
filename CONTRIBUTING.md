# Contributing

Thanks for helping. Issues labelled `good first issue` say where to start in the code and when the
work is done; [ROADMAP.md](./ROADMAP.md) has the bigger picture. Comment on an issue before you
start, so two people do not do the same work.

## Setup

```bash
git clone --recursive https://github.com/ahmad-codex/purser && cd purser
npm install
```

You need Node 22 and either [Foundry](https://getfoundry.sh) or Docker (`contracts/forge.sh` runs
Foundry from its Docker image).

## Checks

```bash
cd contracts
forge fmt --check
forge build
forge test                 # unit, fuzz and invariant tests
cd ..
npm run typecheck
npm test
./scripts/local-up.sh && npm run build -w @purser/console && npm run server
npm run demo               # in another terminal
```

CI runs all of these, plus Slither and a Docker build.

## What reviews check

**Contracts**

- A session key must never be able to act outside its policy. Any change to validation or
  execution comes with a unit test, and with a fuzz or invariant test when it is about amounts or
  time.
- Validation reads only the account's own storage and never the clock (ERC-7562). Anything that
  needs time goes in `executeUserOp`.
- Checks and accounting happen before external calls.
- `forge snapshot --check` must pass, or the PR explains the gas change.

**TypeScript**

- Strict types; no `any` without a reason in a comment.
- MCP tool results are written for a model to act on: say what happened and what to do next.
- Never log or return private keys.

## Commits and pull requests

Small, focused pull requests are reviewed fastest. Write commit messages in the imperative ("Add a
gas budget per key"). Update `CHANGELOG.md` under "Unreleased" when behavior or configuration
changes.

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](./SECURITY.md).
