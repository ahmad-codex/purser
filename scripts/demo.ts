// Plays an agent and its owner against a running Purser server, over MCP like a real client.
//
//   ./scripts/local-up.sh && npm run server      # in one terminal
//   npm run demo                                  # in another
//
// Exits non-zero if any step does not behave as expected, so CI runs it as the end-to-end test.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = (process.env.PURSER_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const pace = Number(process.env.DEMO_PACE_MS ?? 0);
// Testnet faucets give little ETH: DEMO_SCALE=0.01 runs the same story with 1% of the ETH amounts.
const scale = Number(process.env.DEMO_SCALE ?? 1);
const eth = (amount: number) => String(Number((amount * scale).toPrecision(6)));

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const client = new Client({ name: 'purser-demo', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

let failures = 0;

async function step(title: string, tool: string, args: Record<string, unknown>, expect: RegExp) {
  console.log(`\n${bold(`▶ ${title}`)}`);
  console.log(dim(`  agent calls ${tool}(${JSON.stringify(args)})`));
  const result = await client.callTool({ name: tool, arguments: args });
  const text = (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
  const ok = expect.test(text);
  if (!ok) failures++;
  const colour = text.startsWith('Done') ? green : text.startsWith('Waiting') ? yellow : text.startsWith('Refused') ? red : (s: string) => s;
  console.log(text.split('\n').map((l) => `  ${colour(l)}`).join('\n'));
  if (!ok) console.log(red(`  ✗ expected ${expect}`));
  if (pace) await new Promise((r) => setTimeout(r, pace));
  return text;
}

async function owner(path: string, body: unknown = {}) {
  const res = await fetch(`${base}/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
  return json;
}

const tools = await client.listTools();
console.log(bold('Purser demo'));
console.log(dim(`MCP tools: ${tools.tools.map((t) => t.name).join(', ')}`));

await step('Check balance and limits', 'wallet_status', {}, /left of/);
await step('Pay the merchant within budget', 'send_eth', { to: 'merchant', amount: eth(0.02), reason: 'API credits' }, /^Done/);
await step('Pay in demo dollars', 'send_token', { token: 'dUSD', to: 'merchant', amount: '30', reason: 'Monthly subscription' }, /^Done/);
await step('Buy from an allowed shop contract', 'call_contract', { target: 'shop', function: 'buy(uint256)', args: ['7'], value: eth(0.03), reason: 'Order #7' }, /^Done/);

const big = await step('Try a payment over the limit', 'send_eth', { to: 'merchant', amount: eth(0.2), reason: 'Annual plan' }, /^Waiting for the owner/);
const id = /request (\w+)/.exec(big)?.[1];
if (!id) throw new Error('no request id');

console.log(`\n${bold('▶ The owner reviews the request and approves it')}`);
const approved = await owner(`requests/${id}/approve`);
console.log(`  ${approved.status === 'executed' ? green(`approved and executed: ${approved.txHash}`) : red(JSON.stringify(approved))}`);
if (approved.status !== 'executed') failures++;
await step('Agent checks the request', 'get_request', { id }, /executed/);

await step('Try to pay someone not on the allow-list', 'send_eth', { to: '0x1111111111111111111111111111111111111111', amount: eth(0.01), reason: 'Unknown invoice' }, /^Refused/);

console.log(`\n${bold('▶ The owner hits the kill switch')}`);
await owner('owner/freeze');
console.log(`  ${yellow('account frozen')}`);
await step('Agent tries again while frozen', 'send_eth', { to: 'merchant', amount: eth(0.01), reason: 'Retry' }, /^Refused.*frozen/);
await owner('owner/unfreeze');
console.log(`\n  ${green('account unfrozen')}`);

await step('Final status', 'wallet_status', {}, /left of/);
await client.close();

if (failures) {
  console.log(red(`\n${failures} step(s) did not behave as expected`));
  process.exit(1);
}
console.log(green('\nAll steps behaved as expected.'));
