import type { Session } from './api';
import { period, short, units, until } from './format';

interface Props {
  session: Session;
  now: number;
  isServerAgent: boolean;
  frozen: boolean;
  busy: boolean;
  onRevoke: () => void;
}

export function AgentCard({ session, now, isServerAgent, frozen, busy, onRevoke }: Props) {
  const expired = session.validUntil * 1000 < now;
  const status = !session.active ? 'revoked' : expired ? 'expired' : frozen ? 'frozen' : 'active';

  return (
    <article className={`agent ${status}`}>
      <header>
        <div>
          <h3>{session.label || 'Agent'}</h3>
          <span className="mono muted" title={session.key}>{short(session.key)}</span>
          {isServerAgent && <span className="chip">this server</span>}
        </div>
        <div className="agent-right">
          <span className={`status s-${status}`}>{status}</span>
          {session.active && (
            <button type="button" className="ghost danger" disabled={busy} onClick={onRevoke}>
              Revoke
            </button>
          )}
        </div>
      </header>

      <div className="budgets">
        {session.budgets.map((b) => {
          const per = BigInt(b.perPeriod);
          const spent = per - BigInt(b.remaining);
          const pct = per === 0n ? 0 : Number((spent * 1000n) / per) / 10;
          const resets = BigInt(b.resetsAt);
          return (
            <div className="budget" key={b.token}>
              <div className="budget-head">
                <strong>{b.symbol}</strong>
                <span>
                  {units(b.remaining, b.decimals)} left of {units(b.perPeriod, b.decimals)} per {period(session.period)}
                </span>
              </div>
              <div className={`meter ${pct >= 90 ? 'hot' : pct >= 60 ? 'warm' : ''}`}>
                <span style={{ width: `${pct}%` }} />
              </div>
              <div className="budget-foot muted">
                {BigInt(b.perTx) > 0n && <span>max {units(b.perTx, b.decimals)} per payment</span>}
                {resets > 0n && <span>resets in {until(Number(resets), now)}</span>}
              </div>
            </div>
          );
        })}
      </div>

      <footer className="muted">
        {session.active && !expired ? <>access ends in {until(session.validUntil, now)}</> : <>no access</>}
      </footer>
    </article>
  );
}
