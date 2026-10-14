## What and why

<!-- What this changes and the problem it solves. Link the issue if there is one. -->

## How it was tested

<!-- Commands run, new or changed tests, MCP calls you tried. -->

## Checklist

- [ ] `forge fmt --check`, `forge build` and `forge test` pass (contract changes)
- [ ] `npm run typecheck` and `npm test` pass (TypeScript changes)
- [ ] `npm run demo` still passes against a local chain
- [ ] A session key still cannot act outside its allow-list, caps, budget, window or a freeze
- [ ] Policy changes have a unit test, and a fuzz or invariant test when the property is about amounts or time
- [ ] No private key, RPC key or personal address in code, tests or logs
- [ ] Docs and `CHANGELOG.md` updated where behavior or config changed
