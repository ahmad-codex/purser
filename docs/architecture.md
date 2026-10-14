# Architecture

## Pieces

| Piece | Where | Role |
|---|---|---|
| `PurserAccount` | `contracts/src/PurserAccount.sol` | ERC-4337 account. Owner plus session keys, policy checks, budgets |
| `PurserFactory` | `contracts/src/PurserFactory.sol` | CREATE2 factory for ERC-1967 proxies |
| SDK | `packages/sdk` | Builds, signs and submits user operations; reads state and events |
| Server | `packages/server` | MCP tools for the agent, approvals API for the owner, serves the console |
| Console | `apps/console` | Budgets, approvals, activity, revoke and freeze |

## A payment, step by step

1. The agent calls `send_eth { to: "merchant", amount: "0.01", reason: "API credits" }`.
2. The server resolves `merchant` from its address book and builds the call.
3. It calls `previewCalls(agentKey, calls)` on the account: a view that runs the same checks as the
   contract, including the budget, against the current block. If the call is out of scope it
   returns a refusal; if it is over a limit it creates an approval request.
4. Otherwise it builds a v0.7 `PackedUserOperation` with
   `callData = executeUserOp.selector | abi.encode(Call[])`, gets the hash from the EntryPoint, and
   signs it with the session key: `signature = 0x01 | key | sig`.
5. It submits the operation to a bundler, or self-bundles with `handleOps` from a relayer key that
   the account refunds through the prefund.
6. The EntryPoint calls `validateUserOp`: signature, session state, freeze, allow-list and caps.
   The session window goes back as `validAfter`/`validUntil` in the validation data.
7. The EntryPoint calls `executeUserOp(userOp, hash)`. The account re-checks the session and freeze,
   records the spend for the whole batch, then makes the calls.
8. The server reads the `UserOperationEvent` from the receipt. If execution reverted, it decodes
   the reason from `UserOperationRevertReason`.

## Approvals

An approval request stores the calls, the summary, the agent's reason and why it was blocked. When
the owner approves:

1. The server builds a fresh operation (current nonce) and returns its hash (`POST
   /api/requests/:id/prepare`).
2. The owner signs the hash with their wallet (`personal_sign`), or the server signs with the demo
   owner key in demo mode.
3. The server adds the session signature: `0x02 | key | sessionSig | ownerSig`, and submits.

The account skips caps and budgets for this one operation, but still enforces the allow-list.

## Reading events

Public RPCs limit `eth_getLogs` ranges, sometimes to a few hundred blocks. The SDK's `EventIndex`
reads in chunks, shrinks the chunk when a node refuses a range, starts from the block the demo seed
recorded (or `PURSER_FROM_BLOCK`), and only reads new blocks after that. Session labels come
from `SessionAdded` events; they are cosmetic, so a log failure never blocks a payment.

## Signature formats

| Mode | Bytes | Layout |
|---|---|---|
| Owner | 66 | `0x00 \| ownerSig(65)` |
| Session key | 86 | `0x01 \| key(20) \| sessionSig(65)` |
| Session key with owner approval | 151 | `0x02 \| key(20) \| sessionSig(65) \| ownerSig(65)` |

All signatures are EIP-191 personal signatures over the user operation hash.
