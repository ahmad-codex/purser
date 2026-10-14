import { useCallback, useEffect, useState } from 'react';
import { api, type Snapshot } from './api';
import { ActivityFeed } from './ActivityFeed';
import { AgentCard } from './AgentCard';
import { Requests } from './Requests';
import { short, units } from './format';

const POLL_MS = 2000;

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow();

  const load = useCallback(async () => {
    try {
      setSnap(await api.state());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => document.visibilityState === 'visible' && load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!snap) {
    return <div className="loading">{error ? `Cannot reach the Purser server: ${error}` : 'Loading…'}</div>;
  }

  const { state } = snap;
  const viaServer = snap.canApproveWithoutWallet;
  const pending = snap.requests.filter((r) => r.status === 'pending');
  const symbols = new Map<string, { symbol: string; decimals: number }>([
    ['0x0000000000000000000000000000000000000000', { symbol: 'ETH', decimals: 18 }],
  ]);
  for (const t of state.tokenBalances) symbols.set(t.token.toLowerCase(), t);
  const names = new Map(Object.entries(snap.addressBook).map(([name, addr]) => [addr.toLowerCase(), name]));
  for (const s of state.sessions) if (s.label) names.set(s.key.toLowerCase(), s.label);

  return (
    <div className={`app ${state.frozen ? 'is-frozen' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 32 32" aria-hidden>
            <rect width="32" height="32" rx="8" />
            <path d="M9 12h14v10a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2z" />
            <path d="M12 12V9.5a4 4 0 0 1 8 0V12" />
          </svg>
          Purser
        </div>
        <div className="account">
          <span className="mono" title={state.account}>{short(state.account)}</span>
          <span className="chip">chain {state.chainId}</span>
          {snap.demo && <span className="chip warn">demo keys</span>}
        </div>
        <button
          type="button"
          className={`kill ${state.frozen ? 'on' : ''}`}
          disabled={!!busy}
          onClick={() => act('freeze', () => api.owner(state.frozen ? 'unfreeze' : 'freeze', viaServer))}
        >
          {state.frozen ? 'Unfreeze agents' : 'Freeze all agents'}
        </button>
      </header>

      {state.frozen && <div className="frozen-banner">Frozen. No agent can spend until you unfreeze the account.</div>}
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}

      <section className="balances">
        <div className="balance">
          <span>ETH</span>
          <strong>{units(state.ethBalance, 18)}</strong>
        </div>
        {state.tokenBalances.map((t) => (
          <div className="balance" key={t.token}>
            <span>{t.symbol}</span>
            <strong>{units(t.balance, t.decimals, 2)}</strong>
          </div>
        ))}
        <div className="balance muted-box">
          <span>Owner</span>
          <strong className="mono small">{short(state.owner)}</strong>
        </div>
      </section>

      <main className="grid">
        <div className="col">
          <Requests
            requests={snap.requests}
            pendingCount={pending.length}
            busy={busy}
            explorerUrl={snap.explorerUrl}
            viaServer={viaServer}
            onApprove={(id) => act(`approve-${id}`, () => api.approve(id, viaServer))}
            onReject={(id) => act(`reject-${id}`, () => api.reject(id))}
          />
          <h2 className="section-title">Agents</h2>
          {state.sessions.length === 0 && <p className="muted">No agent keys yet.</p>}
          {state.sessions.map((s) => (
            <AgentCard
              key={s.key}
              session={s}
              now={now}
              isServerAgent={s.key.toLowerCase() === snap.agent.toLowerCase()}
              frozen={state.frozen}
              busy={!!busy}
              onRevoke={() => act(`revoke-${s.key}`, () => api.owner('revoke', viaServer, s.key))}
            />
          ))}
        </div>
        <ActivityFeed activity={snap.activity} now={now} symbols={symbols} names={names} explorerUrl={snap.explorerUrl} />
      </main>
    </div>
  );
}
