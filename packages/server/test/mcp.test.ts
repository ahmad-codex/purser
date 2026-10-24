import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp.ts';
import { RequestStore } from '../src/requests.ts';
import type { ActionResult, WalletService } from '../src/service.ts';

const call = { target: '0x000000000000000000000000000000000000bEEF' as const, value: 10n ** 18n, data: '0x' as const };

/** An MCP client connected in memory to a server backed by a stub service. */
async function connect(results: Partial<Record<'sendEth' | 'sendToken' | 'callContract', ActionResult>> = {}) {
  const requests = new RequestStore(mkdtempSync(join(tmpdir(), 'purser-')));
  const unused = () => Promise.reject(new Error('not stubbed'));
  const me = {
    key: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    label: 'demo agent',
    active: true,
    validUntil: 1_800_000_000,
    period: 86_400,
    budgets: [{ symbol: 'ETH', decimals: 18, perTx: 5n * 10n ** 16n, perPeriod: 10n ** 17n, remaining: 8n * 10n ** 16n, resetsAt: 0n }],
  };
  const service = {
    requests,
    config: { addressBook: { merchant: '0x000000000000000000000000000000000000bEEF' }, tokens: { dUSD: '0x01' } },
    status: async () => ({ state: {}, me }),
    describeState: () => 'Account 0xabc on chain 31337',
    sendEth: async () => results.sendEth ?? unused(),
    sendToken: async () => results.sendToken ?? unused(),
    callContract: async () => results.callContract ?? unused(),
  } as unknown as WalletService;

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(service).connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return (res.content as { text: string }[]).map((c) => c.text).join('\n');
  };
  return { client, requests, run };
}

describe('MCP tools', () => {
  it('declares every hint, so hosts can tell reads from payments', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));

    const pays = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
    const reads = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
    expect(hints).toEqual({
      wallet_status: { ...reads, openWorldHint: true },
      send_eth: pays,
      send_token: pays,
      call_contract: pays,
      get_request: { ...reads, openWorldHint: false },
      list_requests: { ...reads, openWorldHint: false },
    });
  });

  it('wallet_status shows the agent its own limits and where it can pay', async () => {
    const { run } = await connect();
    expect(await run('wallet_status')).toBe(
      [
        'Account 0xabc on chain 31337',
        'Your key 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC ("demo agent"): active, valid until 2027-01-15T08:00:00.000Z',
        '- ETH: 0.08 ETH left of 0.1 ETH per 24h, max 0.05 ETH per transaction',
        'Known recipients: merchant (0x000000000000000000000000000000000000bEEF)',
        'Known tokens: ETH, dUSD',
      ].join('\n'),
    );
  });

  it('send_eth reports a payment that went through, with the budget left', async () => {
    const { run } = await connect({
      sendEth: { status: 'executed', txHash: '0xabc', summary: 'Send 0.01 ETH to merchant', remaining: ['0.09 ETH left'] },
    });
    expect(await run('send_eth', { to: 'merchant', amount: '0.01', reason: 'credits' })).toBe(
      'Done: Send 0.01 ETH to merchant.\nTransaction: 0xabc\n0.09 ETH left',
    );
  });

  it('send_token tells the agent to wait for the owner when over the limit', async () => {
    const { run } = await connect({
      sendToken: { status: 'needs_approval', requestId: 'r1', summary: 'Send 80 dUSD to merchant', blockedBy: 'over the per-transaction limit' },
    });
    const out = await run('send_token', { token: 'dUSD', to: 'merchant', amount: '80', reason: 'plan' });
    expect(out).toContain('Waiting for the owner: Send 80 dUSD to merchant.');
    expect(out).toContain('Approval request r1 was created.');
  });

  it('call_contract says an approval cannot widen the allow-list', async () => {
    const { run } = await connect({
      callContract: { status: 'rejected', summary: 'Call drain on vault', reason: 'Not allowed.', code: 'CallNotAllowed' },
    });
    expect(await run('call_contract', { target: 'vault', function: 'drain()', reason: 'x' })).toBe(
      'Refused: Call drain on vault. Not allowed. An owner approval cannot change this; only the owner can change what this agent is allowed to do.',
    );
  });

  it('get_request and list_requests read the request store', async () => {
    const { requests, run } = await connect();
    expect(await run('list_requests')).toBe('No approval requests.');

    const r = requests.create({ calls: [call], summary: 'Send 1 ETH', reason: 'plan', blockedBy: 'over budget' });
    requests.update(r.id, { status: 'executed', txHash: '0x01' });
    expect(await run('get_request', { id: r.id })).toBe(`Request ${r.id} (Send 1 ETH) is executed. Transaction: 0x01`);
    expect(await run('list_requests')).toContain(`${r.id} executed`);
    expect(await run('get_request', { id: 'nope' })).toBe('No request nope.');
  });
});
