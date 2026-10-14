import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getAddress, isAddress, type Address, type Hex } from 'viem';

export interface ServerConfig {
  rpcUrl: string;
  account: Address;
  entryPoint?: Address;
  /** The agent's session key. The server signs as the agent; it never needs the owner key. */
  agentKey: Hex;
  /** Pays for handleOps when there is no bundler. Defaults to the agent key. */
  relayerKey?: Hex;
  bundlerUrl?: string;
  /** Demo mode only: lets the console approve, freeze and revoke without a wallet. */
  ownerKey?: Hex;
  demo: boolean;
  host: string;
  port: number;
  dataDir: string;
  consoleDir?: string;
  apiToken?: string;
  explorerUrl?: string;
  fromBlock?: bigint;
  /** Friendly names the agent can use instead of addresses, e.g. { merchant: 0x... }. */
  addressBook: Record<string, Address>;
  /** Token symbols the agent can use instead of addresses. */
  tokens: Record<string, Address>;
}

const env = (name: string) => {
  const v = process.env[`PURSER_${name}`];
  return v === undefined || v === '' ? undefined : v;
};

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`PURSER_${name} is required (see .env.example)`);
  return value;
}

/**
 * Reads configuration from PURSER_* variables. PURSER_DEPLOYMENT may point at a
 * `<chainId>.demo.json` written by the SeedDemo script; it fills in the account, token and address
 * book, and the EntryPoint from the matching `<chainId>.json`.
 */
export function loadConfig(): ServerConfig {
  let fromFile: {
    account?: Address;
    entryPoint?: Address;
    fromBlock?: bigint;
    book: Record<string, Address>;
    tokens: Record<string, Address>;
  } = {
    book: {},
    tokens: {},
  };
  const deployment = env('DEPLOYMENT');
  if (deployment) {
    const path = resolve(deployment);
    const demo = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string | number>;
    const base = join(dirname(path), path.split(/[\\/]/).pop()!.replace('.demo.json', '.json'));
    const core = existsSync(base) ? (JSON.parse(readFileSync(base, 'utf8')) as Record<string, string>) : {};
    fromFile = {
      account: demo.account as Address,
      entryPoint: core.entryPoint as Address | undefined,
      fromBlock: demo.fromBlock !== undefined ? BigInt(demo.fromBlock) : undefined,
      book: {
        ...(demo.merchant ? { merchant: demo.merchant as Address } : {}),
        ...(demo.shop ? { shop: demo.shop as Address } : {}),
      },
      tokens: demo.token ? { dUSD: demo.token as Address } : {},
    };
  }

  const parseMap = (raw: string | undefined): Record<string, Address> =>
    Object.fromEntries(
      (raw ?? '')
        .split(',')
        .map((pair) => pair.trim().split('='))
        .filter(([k, v]) => k && v && isAddress(v))
        .map(([k, v]) => [k!, getAddress(v!)]),
    );

  const demo = env('DEMO') === 'true';
  const ownerKey = env('OWNER_PRIVATE_KEY') as Hex | undefined;
  if (ownerKey && !demo) throw new Error('PURSER_OWNER_PRIVATE_KEY is only allowed with PURSER_DEMO=true');

  return {
    rpcUrl: env('RPC_URL') ?? 'http://127.0.0.1:8545',
    account: getAddress(required('ACCOUNT', env('ACCOUNT') ?? fromFile.account)),
    entryPoint: (env('ENTRY_POINT') as Address | undefined) ?? fromFile.entryPoint,
    agentKey: required('AGENT_PRIVATE_KEY', env('AGENT_PRIVATE_KEY')) as Hex,
    relayerKey: env('RELAYER_PRIVATE_KEY') as Hex | undefined,
    bundlerUrl: env('BUNDLER_URL'),
    ownerKey,
    demo,
    host: env('HOST') ?? '127.0.0.1',
    port: Number(env('PORT') ?? 8787),
    dataDir: env('DATA_DIR') ?? '.purser',
    consoleDir: env('CONSOLE_DIR'),
    apiToken: env('API_TOKEN'),
    explorerUrl: env('EXPLORER_URL'),
    fromBlock: env('FROM_BLOCK') ? BigInt(env('FROM_BLOCK')!) : fromFile.fromBlock,
    addressBook: { ...fromFile.book, ...parseMap(env('ADDRESS_BOOK')) },
    tokens: { ...fromFile.tokens, ...parseMap(env('TOKENS')) },
  };
}
