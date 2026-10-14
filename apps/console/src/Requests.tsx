import type { ApprovalRequest } from './api';
import { short } from './format';

interface Props {
  requests: ApprovalRequest[];
  pendingCount: number;
  busy: string | null;
  explorerUrl?: string;
  viaServer: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

export function Requests({ requests, pendingCount, busy, explorerUrl, viaServer, onApprove, onReject }: Props) {
  const pending = requests.filter((r) => r.status === 'pending');
  const recent = requests.filter((r) => r.status !== 'pending').slice(0, 4);

  return (
    <section className={`requests ${pendingCount ? 'has-pending' : ''}`}>
      <h2 className="section-title">
        Approvals {pendingCount > 0 && <span className="badge">{pendingCount} waiting</span>}
      </h2>
      {pending.length === 0 && <p className="muted">Nothing waiting. Payments over an agent's limits show up here.</p>}
      {pending.map((r) => (
        <article className="request" key={r.id}>
          <div className="request-main">
            <strong>{r.summary}</strong>
            <span className="reason">“{r.reason}”</span>
            <span className="blocked">{r.blockedBy}</span>
          </div>
          <div className="request-actions">
            <button type="button" className="approve" disabled={!!busy} onClick={() => onApprove(r.id)}>
              {busy === `approve-${r.id}` ? 'Approving…' : viaServer ? 'Approve' : 'Approve with wallet'}
            </button>
            <button type="button" className="ghost" disabled={!!busy} onClick={() => onReject(r.id)}>
              Reject
            </button>
          </div>
        </article>
      ))}
      {recent.length > 0 && (
        <ul className="history">
          {recent.map((r) => (
            <li key={r.id}>
              <span className={`status s-${r.status}`}>{r.status}</span>
              <span>{r.summary}</span>
              {r.txHash &&
                (explorerUrl ? (
                  <a className="mono" href={`${explorerUrl}/tx/${r.txHash}`} target="_blank" rel="noreferrer">
                    {short(r.txHash)}
                  </a>
                ) : (
                  <span className="mono muted">{short(r.txHash)}</span>
                ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
