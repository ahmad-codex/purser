import type { Activity } from './api';
import { ago, short, units } from './format';

interface Props {
  activity: Activity[];
  now: number;
  symbols: Map<string, { symbol: string; decimals: number }>;
  names: Map<string, string>;
  explorerUrl?: string;
}

const SELECTOR_NAMES: Record<string, string> = {
  '0x00000000': 'payment',
  '0xa9059cbb': 'transfer',
  '0x095ea7b3': 'approve',
};

export function ActivityFeed({ activity, now, symbols, names, explorerUrl }: Props) {
  const name = (a: unknown) => {
    const s = String(a ?? '');
    return names.get(s.toLowerCase()) ?? short(s);
  };
  const spentTx = new Set(activity.filter((a) => a.event === 'Spent').map((a) => a.txHash));

  const rows = activity.flatMap((a) => {
    const args = a.args;
    switch (a.event) {
      case 'Spent': {
        const t = symbols.get(String(args.token).toLowerCase()) ?? { symbol: 'tokens', decimals: 18 };
        return [{ a, icon: '↗', tone: args.approvedByOwner ? 'approved' : 'spend', text: `${name(args.key)} spent ${units(String(args.amount), t.decimals)} ${t.symbol}`, note: args.approvedByOwner ? 'approved by owner' : undefined }];
      }
      case 'Executed': {
        if (spentTx.has(a.txHash) && args.mode !== 0) return [];
        const fn = SELECTOR_NAMES[String(args.selector)] ?? String(args.selector);
        const who = Number(args.mode) === 0 ? 'Owner' : name(args.signer);
        return [{ a, icon: '⚡', tone: 'call', text: `${who}: ${fn} → ${name(args.target)}`, note: undefined }];
      }
      case 'SessionAdded':
        return [{ a, icon: '＋', tone: 'admin', text: `Agent key granted: ${args.label || short(String(args.key))}`, note: undefined }];
      case 'SessionRevoked':
        return [{ a, icon: '✕', tone: 'danger', text: `Agent key revoked: ${name(args.key)}`, note: undefined }];
      case 'Frozen':
        return [{ a, icon: args.frozen ? '❄' : '☀', tone: args.frozen ? 'danger' : 'admin', text: args.frozen ? 'Account frozen' : 'Account unfrozen', note: undefined }];
      case 'OwnerChanged':
        return [{ a, icon: '★', tone: 'admin', text: `Owner set to ${short(String(args.newOwner))}`, note: undefined }];
      default:
        return [];
    }
  });

  return (
    <aside className="activity">
      <h2 className="section-title">Activity</h2>
      {rows.length === 0 && <p className="muted">No activity yet.</p>}
      <ol>
        {rows.map(({ a, icon, tone, text, note }, i) => (
          <li key={`${a.txHash}-${i}`} className={`act t-${tone}`}>
            <span className="icon">{icon}</span>
            <div>
              <div>{text}</div>
              <div className="muted small">
                {ago(a.timestamp, now)}
                {note && <> · {note}</>}
                {' · '}
                {explorerUrl ? (
                  <a href={`${explorerUrl}/tx/${a.txHash}`} target="_blank" rel="noreferrer">
                    {short(a.txHash)}
                  </a>
                ) : (
                  <span className="mono">{short(a.txHash)}</span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}
