import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from 'viem';
import { entryPointAbi, purserAccountAbi } from './abi.ts';
import type { Call } from './calls.ts';
import { decodePolicyError, policyErrorFrom, type PolicyError } from './errors.ts';
import { EventIndex, type ActivityItem } from './events.ts';
import {
  approvedSignature,
  buildUserOp,
  sessionSignature,
  signHash,
  toRpcUserOp,
  type GasSettings,
  type PackedUserOperation,
} from './userop.ts';

export interface PurserClientConfig {
  rpcUrl: string;
  /** Purser account address. */
  account: Address;
  /** EntryPoint v0.7. Defaults to the canonical address. */
  entryPoint?: Address;
  /** viem chain; built from the RPC's chain id when omitted. */
  chain?: Chain;
  /** ERC-4337 bundler URL. Without one, `relayer` submits `handleOps` itself. */
  bundlerUrl?: string;
  /** Pays for `handleOps` when there is no bundler; the account refunds it. */
  relayer?: LocalAccount;
  gas?: Partial<GasSettings>;
  /** First block to read account events from. */
  fromBlock?: bigint;
}

export interface TokenBudget {
  token: Address;
  symbol: string;
  decimals: number;
  perTx: bigint;
  perPeriod: bigint;
  spent: bigint;
  remaining: bigint;
  /** Unix seconds when the current period ends, or 0 when nothing was spent this period. */
  resetsAt: bigint;
}

export interface SessionState {
  key: Address;
  label: string;
  active: boolean;
  validAfter: number;
  validUntil: number;
  period: number;
  budgets: TokenBudget[];
}

export interface AccountState {
  chainId: number;
  account: Address;
  owner: Address;
  frozen: boolean;
  deployed: boolean;
  ethBalance: bigint;
  tokenBalances: { token: Address; symbol: string; decimals: number; balance: bigint }[];
  sessions: SessionState[];
}

export interface SendResult {
  userOpHash: Hex;
  txHash: Hex;
  success: boolean;
  error?: PolicyError;
}

/** Thrown when an operation is rejected before it runs (validation) or fails a dry run. */
export class PolicyViolationError extends Error {
  constructor(public readonly detail: PolicyError) {
    super(detail.message);
    this.name = 'PolicyViolationError';
  }
}

export const CANONICAL_ENTRY_POINT: Address = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

const DEFAULT_GAS = {
  verificationGasLimit: 500_000n,
  callGasLimit: 600_000n,
  preVerificationGas: 80_000n,
};

export class PurserClient {
  readonly publicClient: PublicClient;
  readonly account: Address;
  readonly entryPoint: Address;
  private readonly config: PurserClientConfig;
  private chain?: Chain;
  private readonly events: EventIndex;
  private readonly tokenMeta = new Map<Address, { symbol: string; decimals: number }>();

  constructor(config: PurserClientConfig) {
    this.config = config;
    this.account = config.account;
    this.entryPoint = config.entryPoint ?? CANONICAL_ENTRY_POINT;
    this.chain = config.chain;
    this.publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) }) as PublicClient;
    this.events = new EventIndex(this.publicClient, this.account, config.fromBlock);
  }

  // -----------------------------------------------------------------------------------------------
  // Reading
  // -----------------------------------------------------------------------------------------------

  async getState(): Promise<AccountState> {
    const c = this.publicClient;
    const code = await c.getCode({ address: this.account });
    const deployed = !!code && code !== '0x';
    const [chainId, ethBalance] = await Promise.all([c.getChainId(), c.getBalance({ address: this.account })]);
    if (!deployed) {
      return { chainId, account: this.account, owner: zeroAddress, frozen: false, deployed, ethBalance, tokenBalances: [], sessions: [] };
    }
    const read = <T>(functionName: string, args: readonly unknown[] = []) =>
      c.readContract({ address: this.account, abi: purserAccountAbi, functionName: functionName as never, args: args as never }) as Promise<T>;

    const [owner, frozen, keys] = await Promise.all([
      read<Address>('owner'),
      read<boolean>('frozen'),
      read<readonly Address[]>('sessionKeys'),
    ]);
    const labels = await this.labels();
    const sessions = await Promise.all(keys.map((k) => this.getSession(k, labels)));
    const tokens = [...new Set(sessions.flatMap((s) => s.budgets.map((b) => b.token)).filter((t) => t !== zeroAddress))];
    const tokenBalances = await Promise.all(
      tokens.map(async (token) => {
        const meta = await this.token(token);
        const balance = await c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [this.account] });
        return { token, ...meta, balance };
      }),
    );
    return { chainId, account: this.account, owner, frozen, deployed, ethBalance, tokenBalances, sessions };
  }

  async getSession(key: Address, labels?: Map<string, string>): Promise<SessionState> {
    const c = this.publicClient;
    const s = (await c.readContract({ address: this.account, abi: purserAccountAbi, functionName: 'getSession', args: [key] })) as {
      active: boolean;
      period: number;
      validAfter: number;
      validUntil: number;
    };
    const tokens = (await c.readContract({ address: this.account, abi: purserAccountAbi, functionName: 'budgetTokens', args: [key] })) as readonly Address[];
    const budgets = await Promise.all(
      tokens.map(async (token): Promise<TokenBudget> => {
        const [b, remaining, resetsAt] = (await c.readContract({
          address: this.account,
          abi: purserAccountAbi,
          functionName: 'getBudget',
          args: [key, token],
        })) as readonly [{ perTx: bigint; perPeriod: bigint; spent: bigint }, bigint, bigint];
        const meta = await this.token(token);
        return { token, ...meta, perTx: b.perTx, perPeriod: b.perPeriod, spent: b.spent, remaining, resetsAt };
      }),
    );
    const names = labels ?? (await this.labels());
    return {
      key,
      label: names.get(key.toLowerCase()) ?? '',
      active: s.active,
      validAfter: Number(s.validAfter),
      validUntil: Number(s.validUntil),
      period: Number(s.period),
      budgets,
    };
  }

  /** Dry run against the policy, as the session key, right now. */
  async preview(key: Address, calls: readonly Call[]): Promise<{ ok: true } | { ok: false; error: PolicyError }> {
    const [ok, reason] = (await this.publicClient.readContract({
      address: this.account,
      abi: purserAccountAbi,
      functionName: 'previewCalls',
      args: [key, calls.map((c) => ({ ...c }))],
    })) as readonly [boolean, Hex];
    if (ok) return { ok: true };
    return {
      ok: false,
      error: decodePolicyError(reason) ?? { name: 'Unknown', args: [], message: 'The policy rejected this call.', approvable: false },
    };
  }

  /** Account events, newest first. */
  async getActivity(limit = 50): Promise<ActivityItem[]> {
    const items = await this.events.all();
    return items.slice(-limit).reverse();
  }

  async token(token: Address): Promise<{ symbol: string; decimals: number }> {
    if (token === zeroAddress) return { symbol: 'ETH', decimals: 18 };
    const cached = this.tokenMeta.get(token);
    if (cached) return cached;
    const [symbol, decimals] = await Promise.all([
      this.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'TOKEN'),
      this.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
    ]);
    const meta = { symbol, decimals: Number(decimals) };
    this.tokenMeta.set(token, meta);
    return meta;
  }

  // -----------------------------------------------------------------------------------------------
  // Writing
  // -----------------------------------------------------------------------------------------------

  /** Builds an unsigned user operation with the current nonce and fees. */
  async prepare(calls: readonly Call[]): Promise<PackedUserOperation> {
    const c = this.publicClient;
    const [nonce, fees] = await Promise.all([
      c.readContract({ address: this.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [this.account, 0n] }) as Promise<bigint>,
      c.estimateFeesPerGas().catch(async () => {
        const gasPrice = await c.getGasPrice();
        return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice };
      }),
    ]);
    const maxFeePerGas = (fees.maxFeePerGas ?? 1_000_000_000n) * 2n;
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? maxFeePerGas;
    return buildUserOp({
      sender: this.account,
      nonce,
      calls,
      gas: { ...DEFAULT_GAS, ...this.config.gas, maxFeePerGas, maxPriorityFeePerGas: maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : maxPriorityFeePerGas },
    });
  }

  async userOpHash(op: PackedUserOperation): Promise<Hex> {
    return (await this.publicClient.readContract({
      address: this.entryPoint,
      abi: entryPointAbi,
      functionName: 'getUserOpHash',
      args: [op],
    })) as Hex;
  }

  /** Signs with a session key and submits. Throws PolicyViolationError when validation rejects it. */
  async sendAsSession(session: LocalAccount, calls: readonly Call[]): Promise<SendResult> {
    const op = await this.prepare(calls);
    const hash = await this.userOpHash(op);
    op.signature = sessionSignature(session.address, await signHash(session, hash));
    return this.submit(op, hash);
  }

  /**
   * Signs with a session key plus the owner's approval and submits. `ownerSign` gets the user
   * operation hash and returns the owner's EIP-191 signature (from a wallet, a key, or a person).
   */
  async sendApproved(session: LocalAccount, calls: readonly Call[], ownerSign: (userOpHash: Hex) => Promise<Hex>): Promise<SendResult> {
    const op = await this.prepare(calls);
    const hash = await this.userOpHash(op);
    const sessionSig = await signHash(session, hash);
    op.signature = approvedSignature(session.address, sessionSig, await ownerSign(hash));
    return this.submit(op, hash);
  }

  /** Submits a signed user operation through the bundler, or through `handleOps` with the relayer. */
  async submit(op: PackedUserOperation, userOpHash?: Hex): Promise<SendResult> {
    const hash = userOpHash ?? (await this.userOpHash(op));
    if (this.config.bundlerUrl) return this.submitToBundler(op, hash);
    return this.selfBundle(op, hash);
  }

  private async selfBundle(op: PackedUserOperation, userOpHash: Hex): Promise<SendResult> {
    const relayer = this.config.relayer;
    if (!relayer) throw new Error('set bundlerUrl or relayer to submit user operations');
    const chain = await this.resolveChain();
    const wallet = createWalletClient({ account: relayer, chain, transport: http(this.config.rpcUrl) });
    try {
      await this.publicClient.simulateContract({
        account: relayer,
        address: this.entryPoint,
        abi: entryPointAbi,
        functionName: 'handleOps',
        args: [[op], relayer.address],
      });
    } catch (err) {
      const detail = policyErrorFrom(err);
      if (detail) throw new PolicyViolationError(detail);
      throw err;
    }
    const txHash = await wallet.writeContract({
      address: this.entryPoint,
      abi: entryPointAbi,
      functionName: 'handleOps',
      args: [[op], relayer.address],
      gas: 2_000_000n,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { userOpHash, txHash, ...this.outcome(receipt.logs, userOpHash) };
  }

  private async submitToBundler(op: PackedUserOperation, userOpHash: Hex): Promise<SendResult> {
    const rpc = async (method: string, params: unknown[]) => {
      const res = await fetch(this.config.bundlerUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const body = (await res.json()) as { result?: unknown; error?: { message: string; data?: Hex } };
      if (body.error) {
        const detail = decodePolicyError(body.error.data);
        if (detail) throw new PolicyViolationError(detail);
        throw new Error(body.error.message);
      }
      return body.result;
    };
    await rpc('eth_sendUserOperation', [toRpcUserOp(op), this.entryPoint]);
    for (let i = 0; i < 60; i++) {
      const receipt = (await rpc('eth_getUserOperationReceipt', [userOpHash])) as
        | { success: boolean; receipt: { transactionHash: Hex; logs: never[] } }
        | null;
      if (receipt) {
        return { userOpHash, txHash: receipt.receipt.transactionHash, ...this.outcome(receipt.receipt.logs, userOpHash) };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`user operation ${userOpHash} was not included within 2 minutes`);
  }

  private outcome(logs: readonly { topics: readonly Hex[]; data: Hex }[], userOpHash: Hex): { success: boolean; error?: PolicyError } {
    const events = parseEventLogs({ abi: entryPointAbi, logs: logs as never });
    const op = events.find((e) => e.eventName === 'UserOperationEvent' && (e.args as { userOpHash: Hex }).userOpHash === userOpHash);
    if (!op) throw new Error('UserOperationEvent not found in the receipt');
    const success = (op.args as { success: boolean }).success;
    if (success) return { success };
    const revert = events.find((e) => e.eventName === 'UserOperationRevertReason' && (e.args as { userOpHash: Hex }).userOpHash === userOpHash);
    const error = decodePolicyError((revert?.args as { revertReason?: Hex } | undefined)?.revertReason);
    return { success, error };
  }

  private async resolveChain(): Promise<Chain> {
    if (this.chain) return this.chain;
    const id = await this.publicClient.getChainId();
    this.chain = defineChain({
      id,
      name: `chain-${id}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [this.config.rpcUrl] } },
    });
    return this.chain;
  }

  /** Session labels from SessionAdded events. Labels are cosmetic, so a log failure yields none. */
  private async labels(): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    try {
      for (const e of await this.events.all()) {
        if (e.event === 'SessionAdded') labels.set(String(e.args.key).toLowerCase(), String(e.args.label ?? ''));
      }
    } catch {
      // Fall through with whatever was found.
    }
    return labels;
  }
}
