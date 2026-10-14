import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Call, PackedUserOperation } from '@purser/sdk';
import type { Hex } from 'viem';

export type RequestStatus = 'pending' | 'executed' | 'failed' | 'rejected';

/** An action the agent asked for that is over its limits and waits for the owner. */
export interface ApprovalRequest {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: RequestStatus;
  /** What the agent said it is for. */
  reason: string;
  /** One line a person can read, e.g. "Send 0.2 ETH to merchant". */
  summary: string;
  /** Why the policy refused it. */
  blockedBy: string;
  calls: Call[];
  /** Operation prepared for the owner to sign; replaced when the nonce moves on. */
  prepared?: { op: PackedUserOperation; userOpHash: Hex };
  txHash?: Hex;
  error?: string;
}

/**
 * JSON-file store. Small on purpose: one owner, a handful of pending requests. It re-reads the file
 * when another process (a stdio server next to the console server) has changed it.
 */
export class RequestStore {
  private readonly file: string;
  private items: ApprovalRequest[] = [];
  private loadedAt = 0;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'requests.json');
    this.reload();
  }

  private reload() {
    if (!existsSync(this.file)) return;
    const mtime = statSync(this.file).mtimeMs;
    if (mtime === this.loadedAt) return;
    this.items = JSON.parse(readFileSync(this.file, 'utf8'), revive) as ApprovalRequest[];
    this.loadedAt = mtime;
  }

  list(): ApprovalRequest[] {
    this.reload();
    return [...this.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): ApprovalRequest | undefined {
    this.reload();
    return this.items.find((r) => r.id === id || r.id.startsWith(id));
  }

  create(input: Pick<ApprovalRequest, 'reason' | 'summary' | 'blockedBy' | 'calls'>): ApprovalRequest {
    this.reload();
    const now = new Date().toISOString();
    const request: ApprovalRequest = { id: randomUUID().slice(0, 8), createdAt: now, updatedAt: now, status: 'pending', ...input };
    this.items.push(request);
    this.save();
    return request;
  }

  update(id: string, patch: Partial<ApprovalRequest>): ApprovalRequest {
    const request = this.get(id);
    if (!request) throw new Error(`request ${id} not found`);
    Object.assign(request, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return request;
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items, replace, 2));
    renameSync(tmp, this.file);
    this.loadedAt = statSync(this.file).mtimeMs;
  }
}

/** JSON replacer that keeps bigints as "123n" strings. */
export function replace(_key: string, value: unknown) {
  return typeof value === 'bigint' ? `${value}n` : value;
}

function revive(_key: string, value: unknown) {
  return typeof value === 'string' && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value;
}
