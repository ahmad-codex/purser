import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RequestStore } from '../src/requests.ts';

const call = { target: '0x000000000000000000000000000000000000bEEF' as const, value: 10n ** 18n, data: '0x' as const };
const input = { calls: [call], summary: 'Send 1 ETH', reason: 'test', blockedBy: 'over budget' };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newDir = () => mkdtempSync(join(tmpdir(), 'purser-'));

describe('RequestStore expiry', () => {
  it('marks a pending request as expired once it is older than the TTL, and keeps it expired', async () => {
    const dir = newDir();
    const store = new RequestStore(dir, 100);
    const created = store.create(input);
    expect(store.get(created.id)?.status).toBe('pending');

    await wait(150);
    expect(store.get(created.id)?.status).toBe('expired');
    expect(new RequestStore(dir).get(created.id)?.status).toBe('expired');
  });

  it('reports expired requests in the list', async () => {
    const store = new RequestStore(newDir(), 100);
    const created = store.create(input);
    await wait(150);
    expect(store.list().find((r) => r.id === created.id)?.status).toBe('expired');
  });

  it('does not expire requests the owner already decided', async () => {
    const store = new RequestStore(newDir(), 100);
    const created = store.create(input);
    store.update(created.id, { status: 'executed', txHash: '0x01' });
    await wait(150);
    expect(store.get(created.id)?.status).toBe('executed');
  });

  it('keeps a request pending while it is within the TTL', () => {
    const store = new RequestStore(newDir());
    const created = store.create(input);
    expect(store.get(created.id)?.status).toBe('pending');
  });
});
