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

interface Eip6963ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193;
}

/** What the picker shows for each wallet that announced itself. */
export type WalletInfo = Eip6963ProviderDetail['info'];

/** Shows the owner the wallets and resolves to the uuid of the one they pick. */
type WalletChooser = (wallets: WalletInfo[]) => Promise<string>;

const WALLET_CHOICE_KEY = 'purser.wallet';
let chosenWallet: Eip1193 | undefined;
let chooser: WalletChooser | undefined;

/** The console registers its picker here; without one, a browser prompt is used. */
export function setWalletChooser(fn: WalletChooser | undefined): void {
  chooser = fn;
}

// Some private browsing modes throw on storage access, so a failed read or write is not fatal.
function readSavedWallet(): string | null {
  try {
    return localStorage.getItem(WALLET_CHOICE_KEY);
  } catch {
    return null;
  }
}

function saveWallet(rdns: string): void {
  try {
    localStorage.setItem(WALLET_CHOICE_KEY, rdns);
  } catch {
    // The choice is not remembered, which is fine.
  }
}

function forgetWallet(): void {
  chosenWallet = undefined;
  try {
    localStorage.removeItem(WALLET_CHOICE_KEY);
  } catch {
    // Nothing was saved.
  }
}

/** Collects the wallets that announce themselves through EIP-6963. */
function discoverWallets(): Promise<Eip6963ProviderDetail[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Eip6963ProviderDetail>();
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
      found.set(detail.info.uuid, detail);
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      resolve(Array.from(found.values()));
    }, 100);
  });
}

async function askWhich(wallets: Eip6963ProviderDetail[]): Promise<Eip6963ProviderDetail> {
  if (chooser) {
    const uuid = await chooser(wallets.map((w) => w.info));
    const choice = wallets.find((w) => w.info.uuid === uuid);
    if (!choice) throw new Error('No wallet selected.');
    return choice;
  }
  const list = wallets.map((w, i) => `${i + 1}. ${w.info.name}`).join('\n');
  const answer = window.prompt(`Choose the wallet that holds the owner key:\n${list}`, '1');
  const choice = wallets[Number(answer) - 1];
  if (!choice) throw new Error('No wallet selected.');
  return choice;
}

async function wallet(): Promise<Eip1193> {
  if (chosenWallet) return chosenWallet;
  const found = await discoverWallets();
  const saved = readSavedWallet();
  const pick = found.length > 1 ? (found.find((w) => w.info.rdns === saved) ?? (await askWhich(found))) : found[0];
  if (pick) {
    saveWallet(pick.info.rdns);
    chosenWallet = pick.provider;
    return pick.provider;
  }
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error('No wallet found. Install a browser wallet that holds the owner key.');
  return eth;
}

async function ownerAddress(): Promise<string> {
  const accounts = (await (await wallet()).request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts[0]) throw new Error('The wallet returned no account.');
  return accounts[0];
}

export const api = {
  state: () => call<Snapshot>('state'),

  /** Forgets the remembered wallet and asks the owner to choose again. */
  async switchWallet(): Promise<void> {
    forgetWallet();
    await wallet();
  },

  /** Demo mode approves with the server's owner key; otherwise the owner's wallet signs the hash. */
  async approve(id: string, viaServer: boolean): Promise<ApprovalRequest> {
    if (viaServer) return post<ApprovalRequest>(`requests/${id}/approve`);
    const { userOpHash } = await post<{ userOpHash: Hex }>(`requests/${id}/prepare`);
    const from = await ownerAddress();
    const signature = (await (await wallet()).request({ method: 'personal_sign', params: [userOpHash, from] })) as Hex;
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
    await (await wallet()).request({ method: 'eth_sendTransaction', params: [{ from, ...tx }] });
  },
};
