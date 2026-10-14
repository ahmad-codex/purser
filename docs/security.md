# Security model

Purser has not been audited. This page says what it is designed to protect, what it does
not protect, and how that is tested, so you can judge it yourself.

## Actors

| Actor | Holds | Trusted for |
|---|---|---|
| Owner | The owner key (an EOA, or a wallet that signs EIP-191 messages) | Everything: policy, upgrades, approvals |
| Agent | A session key, usually inside the Purser server | Nothing beyond its policy |
| Server | The session key; in demo mode only, also the owner key | Nothing beyond the session key |
| Bundler or relayer | Nothing | Liveness only |

## What the contract guarantees

For a session key, without the owner's co-signature:

1. **Scope.** Every call targets an allow-listed `(contract, function)` pair. The account itself is
   never a target, so a session key cannot grant itself more, revoke others, upgrade or unfreeze.
2. **Per-transaction caps.** Each ETH value and each ERC-20 `transfer`, `approve` or `transferFrom`
   from the account is at most `perTx` for that token. Checked in validation.
3. **Budgets.** Total spending per token in one period is at most `perPeriod`. Checked and recorded
   in `executeUserOp` before any call is made. A batch that would exceed the budget reverts as a
   whole.
4. **Window.** Outside `validAfter..validUntil` the EntryPoint rejects the operation.
5. **Revoke and freeze.** A revoked key or a frozen account stops the key at validation, and again
   at execution, so an owner operation earlier in the same bundle wins.
6. **Fresh grants.** Granting a key again replaces its policy (a new epoch); old permissions and
   spend records do not carry over.

With the owner's co-signature (mode `0x02`), budgets and caps are lifted for that one operation,
which is bound to its user operation hash and nonce. The allow-list still applies.

## What it does not protect against

- **A compromised owner key.** The owner can do anything, including upgrade the account.
- **Gas.** Every operation pays gas from the account, including ones that fail at execution (for
  example, over the budget). A leaked session key can burn ETH this way until it is revoked or
  the account is frozen. A per-key gas budget is planned.
- **Dangerous allow-list entries.** If you allow `ANY_SELECTOR` on a DEX router or a token, the
  agent can do anything that contract allows, within the budget accounting described above. Only
  ETH value and the three ERC-20 functions are counted as spending. Allow specific functions.
- **Token amounts are counted per token**, not in a common currency. There is no price oracle.
- **Approvals are reusable by the spender.** An approved allowance counts once against the budget
  when granted; what the spender later does with it is outside the account.
- **The server.** In demo mode it holds the owner key; never run demo mode with real funds. Outside
  demo mode it refuses an owner key. Its HTTP API binds to localhost by default; set
  `PURSER_API_TOKEN` before exposing it.

## ERC-4337 validation rules

Validation reads only the account's own storage and never the clock, as ERC-7562 requires, so
public bundlers accept these operations. Time-dependent checks (budgets) run in the execution phase
through `executeUserOp`, which receives the whole user operation.

## How it is tested

- 41 unit tests through a real EntryPoint `handleOps`, including signature forgery, replaced keys,
  revoke and freeze in the same bundle, and over-limit approvals.
- Fuzz tests: random sequences of payments and time jumps against a model of the budget, and caps.
- Invariant tests: a handler drives an agent, a clock, and an owner who approves and revokes. The
  invariants are: unapproved spending never exceeds the budget per window, a revoked key never
  moves funds, and the policy never changes without the owner.
- Slither in CI, failing on medium or higher. Excluded detectors and why:

| Detector | Why it is excluded |
|---|---|
| `arbitrary-send-eth`, `low-level-calls` | Sending ETH and calling targets on instruction is what an account does |
| `calls-loop` | Batches are a feature; one failing call reverts the whole operation |
| `incorrect-equality` | `periodStart == 0` is the "nothing spent yet" sentinel |
| `unused-return` | The third value of `tryRecover` is not needed; the error is checked |
| `reentrancy-events` | `Executed` is emitted after the call on purpose: it records a call that happened |
| `timestamp` | Budget periods are day-scale; seconds of drift do not matter |
| `assembly` | Small memory-safe reads of calldata words |
| `naming-convention`, `solc-version` | Style; the compiler is pinned in `foundry.toml` |

## Reporting

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/ahmad-codex/purser/security/advisories/new).
See [SECURITY.md](../SECURITY.md).
