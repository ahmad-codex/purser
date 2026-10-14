# Security policy

Purser holds funds, so security reports matter more than anything else here.

## Reporting a vulnerability

Report privately through
[GitHub security advisories](https://github.com/ahmad-codex/purser/security/advisories/new).
Do not open a public issue. Include the commit, the steps or a failing Foundry test, and the impact
you see.

You will get an answer within 72 hours. Fixes for confirmed issues are released before the details
are published, and reporters are credited unless they ask not to be.

## Scope

In scope: the contracts in `contracts/src`, the SDK, the server and the console. Especially any way
for a session key to act outside its policy (scope, caps, budget, window, revoke, freeze), or for
anyone but the owner to change the policy or upgrade the account.

Out of scope: the demo keys in `docker-compose.yml` and `scripts/local-up.sh` (they are Anvil's
public development keys), and the limits listed under "What it does not protect against" in
[docs/security.md](./docs/security.md).

## Status

The contracts have not been audited. Do not hold real funds in an account you have not reviewed.
