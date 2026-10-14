import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RequestStore } from '../src/requests.ts';

const call = { target: '0x000000000000000000000000000000000000bEEF' as const, value: 10n ** 18n, data: '0x' as const };

describe('RequestStore', () => {
  it('persists requests, including bigint values, across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'purser-'));
    const store = new RequestStore(dir);
    const created = store.create({ calls: [call], summary: 'Send 1 ETH', reason: 'test', blockedBy: 'over budget' });
    expect(created.status).toBe('pending');
    store.update(created.id, { status: 'executed', txHash: '0x01' });

    const reopened = new RequestStore(dir);
    const r = reopened.get(created.id)!;
    expect(r.status).toBe('executed');
    expect(r.calls[0]!.value).toBe(10n ** 18n);
  });

  it('sees changes made by another process sharing the data directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'purser-'));
    const stdio = new RequestStore(dir);
    const console = new RequestStore(dir);
    const created = stdio.create({ calls: [call], summary: 'Send 1 ETH', reason: 'test', blockedBy: 'over budget' });
    expect(console.get(created.id)?.status).toBe('pending');

    await new Promise((r) => setTimeout(r, 20));
    console.update(created.id, { status: 'executed' });
    expect(stdio.get(created.id)?.status).toBe('executed');
  });

  it('finds requests by id prefix and lists newest first', async () => {
    const store = new RequestStore(mkdtempSync(join(tmpdir(), 'purser-')));
    const a = store.create({ calls: [call], summary: 'a', reason: 'r', blockedBy: 'b' });
    await new Promise((r) => setTimeout(r, 5));
    const b = store.create({ calls: [call], summary: 'b', reason: 'r', blockedBy: 'b' });
    expect(store.get(a.id.slice(0, 4))?.id).toBe(a.id);
    expect(store.list().map((r) => r.id)).toEqual([b.id, a.id]);
  });
});
