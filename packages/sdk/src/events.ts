import { parseEventLogs, type Address, type Hex, type PublicClient } from 'viem';
import { purserAccountAbi } from './abi.ts';

export interface ActivityItem {
  blockNumber: bigint;
  txHash: Hex;
  timestamp: number;
  event: string;
  args: Record<string, unknown>;
}

const MAX_CHUNK = 5_000n;
const MIN_CHUNK = 50n;
/** Without a start block, look this far back on the first scan. */
const DEFAULT_LOOKBACK = 5_000n;

/**
 * Incremental reader of an account's events. Public RPCs cap eth_getLogs ranges (sometimes at a
 * few hundred blocks), so it reads in chunks, shrinks the chunk when a node refuses a range, and
 * only reads new blocks on later calls.
 */
export class EventIndex {
  private items: ActivityItem[] = [];
  private scannedTo?: bigint;
  private chunk = MAX_CHUNK;
  private readonly timestamps = new Map<bigint, number>();
  private running?: Promise<void>;

  constructor(
    private readonly client: PublicClient,
    private readonly address: Address,
    private readonly fromBlock?: bigint,
  ) {}

  /** All indexed events, oldest first, after catching up with the chain. */
  async all(): Promise<ActivityItem[]> {
    this.running ??= this.catchUp().finally(() => {
      this.running = undefined;
    });
    await this.running;
    return this.items;
  }

  private async catchUp(): Promise<void> {
    const latest = await this.client.getBlockNumber();
    let from =
      this.scannedTo !== undefined
        ? this.scannedTo + 1n
        : (this.fromBlock ?? (latest > DEFAULT_LOOKBACK ? latest - DEFAULT_LOOKBACK : 0n));
    while (from <= latest) {
      const to = from + this.chunk - 1n > latest ? latest : from + this.chunk - 1n;
      let logs;
      try {
        logs = await this.client.getLogs({ address: this.address, fromBlock: from, toBlock: to });
      } catch (err) {
        if (this.chunk <= MIN_CHUNK) throw err;
        this.chunk = this.chunk / 4n < MIN_CHUNK ? MIN_CHUNK : this.chunk / 4n;
        continue;
      }
      for (const log of parseEventLogs({ abi: purserAccountAbi, logs })) {
        const blockNumber = log.blockNumber ?? 0n;
        this.items.push({
          blockNumber,
          txHash: log.transactionHash ?? '0x',
          timestamp: await this.timestamp(blockNumber),
          event: log.eventName,
          args: (log.args ?? {}) as Record<string, unknown>,
        });
      }
      this.scannedTo = to;
      from = to + 1n;
    }
  }

  private async timestamp(blockNumber: bigint): Promise<number> {
    const cached = this.timestamps.get(blockNumber);
    if (cached !== undefined) return cached;
    const block = await this.client.getBlock({ blockNumber });
    const ts = Number(block.timestamp);
    this.timestamps.set(blockNumber, ts);
    return ts;
  }
}
