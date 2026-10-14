export type Hex = `0x${string}`;

export interface TokenBudget {
  token: string;
  symbol: string;
  decimals: number;
  perTx: string;
  perPeriod: string;
  spent: string;
  remaining: string;
  resetsAt: string;
}

export interface Session {
  key: string;
  label: string;
  active: boolean;
  validAfter: number;
  validUntil: number;
  period: number;
  budgets: TokenBudget[];
}

export interface AccountState {
  chainId: number;
  account: string;
  owner: string;
  frozen: boolean;
  deployed: boolean;
  ethBalance: string;
  tokenBalances: { token: string; symbol: string; decimals: number; balance: string }[];
  sessions: Session[];
}

export interface Activity {
  blockNumber: string;
  txHash: string;
  timestamp: number;
  event: string;
  args: Record<string, string | boolean | number>;
}

export interface ApprovalRequest {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'pending' | 'executed' | 'failed' | 'rejected';
  reason: string;
  summary: string;
  blockedBy: string;
  txHash?: string;
  error?: string;
}

export interface Snapshot {
  state: AccountState;
  activity: Activity[];
  requests: ApprovalRequest[];
  agent: string;
  demo: boolean;
  canApproveWithoutWallet: boolean;
  explorerUrl?: string;
  addressBook: Record<string, string>;
}

const TOKEN_KEY = 'purser-api-token';

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function call<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const token = storedToken();
  const res = await fetch(`/api/${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers },
  });
  // The server asks for PURSER_API_TOKEN on owner actions when one is configured.
  if (res.status === 401 && !retried) {
    const entered = window.prompt('API token (PURSER_API_TOKEN)');
    if (entered) {
      try {
        localStorage.setItem(TOKEN_KEY, entered);
      } catch {
        // Private mode: the token works for this request only.
      }
      return call<T>(path, { ...init, headers: { ...init?.headers, authorization: `Bearer ${entered}` } }, true);
    }
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body as T;
}

const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: 'POST', body: JSON.stringify(body) });

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function wallet(): Eip1193 {
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error('No wallet found. Install a browser wallet that holds the owner key.');
  return eth;
}

async function ownerAddress(): Promise<string> {
  const accounts = (await wallet().request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts[0]) throw new Error('The wallet returned no account.');
  return accounts[0];
}

export const api = {
  state: () => call<Snapshot>('state'),

  /** Demo mode approves with the server's owner key; otherwise the owner's wallet signs the hash. */
  async approve(id: string, viaServer: boolean): Promise<ApprovalRequest> {
    if (viaServer) return post<ApprovalRequest>(`requests/${id}/approve`);
    const { userOpHash } = await post<{ userOpHash: Hex }>(`requests/${id}/prepare`);
    const from = await ownerAddress();
    const signature = (await wallet().request({ method: 'personal_sign', params: [userOpHash, from] })) as Hex;
    return post<ApprovalRequest>(`requests/${id}/approve`, { signature });
  },

  reject: (id: string) => post<ApprovalRequest>(`requests/${id}/reject`),

  async owner(action: 'freeze' | 'unfreeze' | 'revoke', viaServer: boolean, key?: string): Promise<void> {
    if (viaServer) {
      await post(`owner/${action}`, { key });
      return;
    }
    const tx = await post<{ to: string; data: string }>(`owner/${action}`, { key, mode: 'calldata' });
    const from = await ownerAddress();
    await wallet().request({ method: 'eth_sendTransaction', params: [{ from, ...tx }] });
  },
};
