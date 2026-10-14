export function units(raw: string, decimals: number, maxFraction = 4): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  if (whole === 0n && v > 0n && !frac) frac = '0'.repeat(maxFraction - 1) + '1';
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function ago(unixSeconds: number, now: number): string {
  const s = Math.max(0, Math.round(now / 1000 - unixSeconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 172_800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function until(unixSeconds: number, now: number): string {
  const s = Math.round(unixSeconds - now / 1000);
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export function period(seconds: number): string {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? 'day' : `${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? 'hour' : `${seconds / 3600} hours`;
  return `${seconds}s`;
}
