import {
  PurserClient,
  PolicyViolationError,
  purserAccountAbi,
  approvedSignature,
  contractCall,
  erc20Transfer,
  ethTransfer,
  signHash,
  type AccountState,
  type Call,
  type PolicyError,
} from '@purser/sdk';
import {
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ServerConfig } from './config.ts';
import { RequestStore, type ApprovalRequest } from './requests.ts';

export type ActionResult =
  | { status: 'executed'; txHash: Hex; explorer?: string; summary: string; remaining: string[] }
  | { status: 'needs_approval'; requestId: string; summary: string; blockedBy: string; approveAt?: string }
  | { status: 'rejected'; summary: string; reason: string; code: string }
  | { status: 'failed'; summary: string; txHash?: Hex; reason: string };

/** What the MCP tools and the HTTP API call. One instance per server. */
export class WalletService {
  readonly client: PurserClient;
  readonly agent: LocalAccount;
  readonly requests: RequestStore;
  private readonly owner?: LocalAccount;

  constructor(readonly config: ServerConfig) {
    this.agent = privateKeyToAccount(config.agentKey);
    this.owner = config.ownerKey ? privateKeyToAccount(config.ownerKey) : undefined;
    this.client = new PurserClient({
      rpcUrl: config.rpcUrl,
      account: config.account,
      entryPoint: config.entryPoint,
      bundlerUrl: config.bundlerUrl,
      relayer: privateKeyToAccount(config.relayerKey ?? config.agentKey),
      fromBlock: config.fromBlock,
    });
    this.requests = new RequestStore(config.dataDir);
  }

  get canApproveWithoutWallet(): boolean {
    return !!this.owner;
  }

  // -----------------------------------------------------------------------------------------------
  // Name resolution
  // -----------------------------------------------------------------------------------------------

  resolveAddress(nameOrAddress: string): Address {
    if (isAddress(nameOrAddress)) return getAddress(nameOrAddress);
    const hit = Object.entries(this.config.addressBook).find(([k]) => k.toLowerCase() === nameOrAddress.toLowerCase());
    if (!hit) {
      const known = Object.keys(this.config.addressBook);
      throw new Error(`Unknown recipient "${nameOrAddress}". Use an address${known.length ? ` or one of: ${known.join(', ')}` : ''}.`);
    }
    return hit[1];
  }

  resolveToken(symbolOrAddress: string): Address {
    if (isAddress(symbolOrAddress)) return getAddress(symbolOrAddress);
    if (symbolOrAddress.toUpperCase() === 'ETH') return zeroAddress;
    const hit = Object.entries(this.config.tokens).find(([k]) => k.toLowerCase() === symbolOrAddress.toLowerCase());
    if (!hit) throw new Error(`Unknown token "${symbolOrAddress}". Use its address or one of: ${Object.keys(this.config.tokens).join(', ') || 'none configured'}.`);
    return hit[1];
  }

  private nameOf(address: Address): string {
    const hit = Object.entries(this.config.addressBook).find(([, a]) => a.toLowerCase() === address.toLowerCase());
    return hit ? hit[0] : `${address.slice(0, 6)}…${address.slice(-4)}`;
  }

  // -----------------------------------------------------------------------------------------------
  // Agent actions
  // -----------------------------------------------------------------------------------------------

  async status() {
    const state = await this.client.getState();
    const me = state.sessions.find((s) => s.key.toLowerCase() === this.agent.address.toLowerCase());
    return { state, me };
  }

  async sendEth(to: string, amount: string, reason: string): Promise<ActionResult> {
    const target = this.resolveAddress(to);
    const value = parseUnits(amount, 18);
    return this.run([ethTransfer(target, value)], `Send ${amount} ETH to ${this.nameOf(target)}`, reason);
  }

  async sendToken(tokenRef: string, to: string, amount: string, reason: string): Promise<ActionResult> {
    const token = this.resolveToken(tokenRef);
    if (token === zeroAddress) return this.sendEth(to, amount, reason);
    const target = this.resolveAddress(to);
    const meta = await this.client.token(token);
    const call = erc20Transfer(token, target, parseUnits(amount, meta.decimals));
    return this.run([call], `Send ${amount} ${meta.symbol} to ${this.nameOf(target)}`, reason);
  }

  async callContract(target: string, signature: string, args: unknown[], valueEth: string | undefined, reason: string): Promise<ActionResult> {
    const address = this.resolveAddress(target);
    const value = valueEth ? parseUnits(valueEth, 18) : 0n;
    const parsedArgs = args.map((a) => (typeof a === 'string' && /^-?\d+$/.test(a) ? BigInt(a) : a));
    const call = contractCall(address, signature, parsedArgs, value);
    const fn = signature.replace(/^function\s+/, '').split('(')[0];
    return this.run([call], `Call ${fn} on ${this.nameOf(address)}${value ? ` with ${valueEth} ETH` : ''}`, reason);
  }

  /** Dry run, then send. Over-limit actions become approval requests; out-of-scope ones are refused. */
  private async run(calls: Call[], summary: string, reason: string): Promise<ActionResult> {
    const preview = await this.client.preview(this.agent.address, calls);
    if (!preview.ok) return this.blocked(calls, summary, reason, preview.error);
    try {
      const result = await this.client.sendAsSession(this.agent, calls);
      if (!result.success) {
        if (result.error?.approvable) return this.blocked(calls, summary, reason, result.error);
        return { status: 'failed', summary, txHash: result.txHash, reason: result.error?.message ?? 'The call reverted.' };
      }
      return { status: 'executed', txHash: result.txHash, explorer: this.txUrl(result.txHash), summary, remaining: await this.remainingLines() };
    } catch (err) {
      if (err instanceof PolicyViolationError) return this.blocked(calls, summary, reason, err.detail);
      throw err;
    }
  }

  private blocked(calls: Call[], summary: string, reason: string, error: PolicyError): ActionResult {
    if (!error.approvable) return { status: 'rejected', summary, reason: error.message, code: error.name };
    const request = this.requests.create({ calls, summary, reason, blockedBy: error.message });
    return { status: 'needs_approval', requestId: request.id, summary, blockedBy: error.message, approveAt: this.consoleUrl() };
  }

  async remainingLines(): Promise<string[]> {
    const session = await this.client.getSession(this.agent.address);
    return session.budgets.map((b) => `${formatUnits(b.remaining, b.decimals)} ${b.symbol} left of ${formatUnits(b.perPeriod, b.decimals)} ${b.symbol} this period`);
  }

  // -----------------------------------------------------------------------------------------------
  // Owner actions
  // -----------------------------------------------------------------------------------------------

  /** Builds the operation for a pending request with the current nonce and returns its hash to sign. */
  async prepareApproval(id: string): Promise<{ userOpHash: Hex }> {
    const request = this.pending(id);
    const op = await this.client.prepare(request.calls);
    const userOpHash = await this.client.userOpHash(op);
    this.requests.update(request.id, { prepared: { op, userOpHash } });
    return { userOpHash };
  }

  /**
   * Executes a pending request with the owner's signature over the prepared hash. Without a
   * signature, the demo owner key signs (demo mode only).
   */
  async approve(id: string, ownerSig?: Hex): Promise<ApprovalRequest> {
    let request = this.pending(id);
    if (!ownerSig) {
      if (!this.owner) throw new Error('An owner signature is required. Approve with your wallet in the console.');
      await this.prepareApproval(request.id);
      request = this.pending(id);
      ownerSig = await signHash(this.owner, request.prepared!.userOpHash);
    }
    if (!request.prepared) throw new Error('Prepare the request before approving it.');
    const { op, userOpHash } = request.prepared;
    const sessionSig = await signHash(this.agent, userOpHash);
    op.signature = approvedSignature(this.agent.address, sessionSig, ownerSig);
    try {
      const result = await this.client.submit(op, userOpHash);
      return this.requests.update(request.id, {
        status: result.success ? 'executed' : 'failed',
        txHash: result.txHash,
        error: result.success ? undefined : (result.error?.message ?? 'The call reverted.'),
      });
    } catch (err) {
      const message = err instanceof PolicyViolationError ? err.detail.message : (err as Error).message;
      return this.requests.update(request.id, { status: 'failed', error: message });
    }
  }

  reject(id: string): ApprovalRequest {
    const request = this.pending(id);
    return this.requests.update(request.id, { status: 'rejected' });
  }

  /** Owner transaction data for the console to send from a wallet: freeze, unfreeze or revoke. */
  ownerCall(action: 'freeze' | 'unfreeze' | 'revoke', key?: Address): { to: Address; data: Hex } {
    const data =
      action === 'revoke'
        ? encodeFunctionData({ abi: purserAccountAbi, functionName: 'revokeSession', args: [key ?? this.agent.address] })
        : encodeFunctionData({ abi: purserAccountAbi, functionName: 'setFrozen', args: [action === 'freeze'] });
    return { to: this.config.account, data };
  }

  /** Demo mode: the server sends the owner call itself. */
  async ownerActDemo(action: 'freeze' | 'unfreeze' | 'revoke', key?: Address): Promise<Hex> {
    if (!this.owner) throw new Error('Owner actions need a wallet outside demo mode.');
    const { to, data } = this.ownerCall(action, key);
    const chainId = await this.client.publicClient.getChainId();
    const wallet = createWalletClient({
      account: this.owner,
      chain: { id: chainId, name: 'local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [this.config.rpcUrl] } } },
      transport: http(this.config.rpcUrl),
    });
    const hash = await wallet.sendTransaction({ to, data });
    await this.client.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  // -----------------------------------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------------------------------

  private pending(id: string): ApprovalRequest {
    const request = this.requests.get(id);
    if (!request) throw new Error(`Request ${id} not found.`);
    if (request.status !== 'pending') throw new Error(`Request ${id} is already ${request.status}.`);
    return request;
  }

  txUrl(hash: Hex): string | undefined {
    return this.config.explorerUrl ? `${this.config.explorerUrl.replace(/\/$/, '')}/tx/${hash}` : undefined;
  }

  consoleUrl(): string {
    return `http://${this.config.host === '0.0.0.0' ? 'localhost' : this.config.host}:${this.config.port}/`;
  }

  describeState(state: AccountState): string {
    const lines = [`Account ${state.account} on chain ${state.chainId}${state.frozen ? ' (FROZEN by the owner)' : ''}`];
    lines.push(`Balance: ${formatUnits(state.ethBalance, 18)} ETH${state.tokenBalances.map((t) => `, ${formatUnits(t.balance, t.decimals)} ${t.symbol}`).join('')}`);
    return lines.join('\n');
  }
}
