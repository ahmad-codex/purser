import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatUnits } from 'viem';
import { z } from 'zod';
import type { ActionResult, WalletService } from './service.ts';

const VERSION = '0.1.0';

/** Refusals about what the agent may do at all, as opposed to how much. */
const SCOPE_ERRORS = new Set(['CallNotAllowed', 'TokenNotAllowed', 'SelfCallNotAllowed']);

/** Hints for MCP hosts: reads are safe to repeat, payments move funds and must be confirmed. */
const reads = (openWorldHint: boolean) => ({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint });
const PAYS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

function describeResult(r: ActionResult): string {
  switch (r.status) {
    case 'executed':
      return [`Done: ${r.summary}.`, `Transaction: ${r.txHash}${r.explorer ? ` (${r.explorer})` : ''}`, ...r.remaining].join('\n');
    case 'needs_approval':
      return [
        `Waiting for the owner: ${r.summary}.`,
        `It is over the agent's limits: ${r.blockedBy}`,
        `Approval request ${r.requestId} was created${r.approveAt ? `; the owner can approve it at ${r.approveAt}` : ''}.`,
        'Tell the user it needs their approval, then check it with get_request.',
      ].join('\n');
    case 'rejected':
      return `Refused: ${r.summary}. ${r.reason}${SCOPE_ERRORS.has(r.code) ? ' An owner approval cannot change this; only the owner can change what this agent is allowed to do.' : ''}`;
    case 'failed':
      return `Failed: ${r.summary}. ${r.reason}${r.txHash ? ` Transaction: ${r.txHash}` : ''}`;
  }
}

/** Builds the MCP server an agent connects to. Every tool acts as the agent's session key. */
export function createMcpServer(service: WalletService): McpServer {
  const server = new McpServer(
    { name: 'purser', version: VERSION },
    {
      instructions:
        'This server is a crypto wallet you can spend from within limits set by its human owner. ' +
        'Call wallet_status first to see your balance, budget and what you are allowed to pay. ' +
        'Payments within the limits run immediately. Payments over the limits become approval requests ' +
        'that the owner approves or rejects; never try to split a payment to get around a limit.',
    },
  );

  server.registerTool(
    'wallet_status',
    {
      title: 'Wallet status',
      description:
        'Balances of the wallet, and your own limits: per-transaction caps, the budget left in the current period ' +
        'and when it resets, when your access expires, and whether the owner has frozen the wallet.',
      inputSchema: {},
      annotations: reads(true),
    },
    async () => {
      const { state, me } = await service.status();
      const lines = [service.describeState(state)];
      if (!me) {
        lines.push('You have no session key on this wallet. Ask the owner to grant one.');
      } else {
        lines.push(`Your key ${me.key}${me.label ? ` ("${me.label}")` : ''}: ${me.active ? 'active' : 'REVOKED'}, valid until ${new Date(me.validUntil * 1000).toISOString()}`);
        for (const b of me.budgets) {
          const f = (v: bigint) => `${formatUnits(v, b.decimals)} ${b.symbol}`;
          lines.push(
            `- ${b.symbol}: ${f(b.remaining)} left of ${f(b.perPeriod)} per ${Math.round(me.period / 3600)}h` +
              `${b.perTx ? `, max ${f(b.perTx)} per transaction` : ''}` +
              `${b.resetsAt ? `, resets at ${new Date(Number(b.resetsAt) * 1000).toISOString()}` : ''}`,
          );
        }
      }
      const book = Object.entries(service.config.addressBook);
      if (book.length) lines.push(`Known recipients: ${book.map(([k, v]) => `${k} (${v})`).join(', ')}`);
      const tokens = Object.keys(service.config.tokens);
      if (tokens.length) lines.push(`Known tokens: ETH, ${tokens.join(', ')}`);
      const pending = service.requests.list().filter((r) => r.status === 'pending');
      if (pending.length) lines.push(`Pending approvals: ${pending.map((r) => `${r.id} (${r.summary})`).join('; ')}`);
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'send_eth',
    {
      title: 'Send ETH',
      description: 'Send ETH from the wallet. Over-limit payments become an approval request for the owner.',
      inputSchema: {
        to: z.string().describe('Recipient address, or a known recipient name from wallet_status'),
        amount: z.string().describe('Amount in ETH, e.g. "0.01"'),
        reason: z.string().describe('What the payment is for, shown to the owner'),
      },
      annotations: PAYS,
    },
    async ({ to, amount, reason }) => text(describeResult(await service.sendEth(to, amount, reason))),
  );

  server.registerTool(
    'send_token',
    {
      title: 'Send tokens',
      description: 'Send ERC-20 tokens from the wallet. Over-limit payments become an approval request for the owner.',
      inputSchema: {
        token: z.string().describe('Token symbol from wallet_status (e.g. "dUSD") or token address'),
        to: z.string().describe('Recipient address or known recipient name'),
        amount: z.string().describe('Amount in whole tokens, e.g. "25.5"'),
        reason: z.string().describe('What the payment is for, shown to the owner'),
      },
      annotations: PAYS,
    },
    async ({ token, to, amount, reason }) => text(describeResult(await service.sendToken(token, to, amount, reason))),
  );

  server.registerTool(
    'call_contract',
    {
      title: 'Call a contract',
      description:
        'Call a function on a contract the owner allowed, optionally sending ETH. ' +
        'Example: target "shop", function "buy(uint256)", args ["42"], value "0.01".',
      inputSchema: {
        target: z.string().describe('Contract address or known name'),
        function: z.string().describe('Function signature, e.g. "buy(uint256)"'),
        args: z.array(z.union([z.string(), z.number(), z.boolean()])).default([]).describe('Arguments in order; integers as strings'),
        value: z.string().optional().describe('ETH to send with the call, e.g. "0.01"'),
        reason: z.string().describe('What the call is for, shown to the owner'),
      },
      annotations: PAYS,
    },
    async (input) =>
      text(describeResult(await service.callContract(input.target, input.function, input.args, input.value, input.reason))),
  );

  server.registerTool(
    'get_request',
    {
      title: 'Approval request status',
      description: 'Check whether the owner approved, rejected or has not yet decided an approval request.',
      inputSchema: { id: z.string().describe('Request id returned when the payment needed approval') },
      annotations: reads(false),
    },
    async ({ id }) => {
      const r = service.requests.get(id);
      if (!r) return text(`No request ${id}.`);
      const tail = r.status === 'executed' ? ` Transaction: ${r.txHash}` : r.error ? ` ${r.error}` : '';
      return text(`Request ${r.id} (${r.summary}) is ${r.status}.${tail}`);
    },
  );

  server.registerTool(
    'list_requests',
    {
      title: 'List approval requests',
      description: 'Recent approval requests and their status.',
      inputSchema: {},
      annotations: reads(false),
    },
    async () => {
      const items = service.requests.list().slice(0, 20);
      if (!items.length) return text('No approval requests.');
      return text(items.map((r) => `${r.id} ${r.status.padEnd(8)} ${r.summary} (${r.reason})`).join('\n'));
    },
  );

  return server;
}
