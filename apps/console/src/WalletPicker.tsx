import { useEffect, useState } from 'react';
import { setWalletChooser, type WalletInfo } from './api';

interface Pending {
  wallets: WalletInfo[];
  resolve: (uuid: string) => void;
  reject: (reason: Error) => void;
}

/** Lets the owner choose between the wallets that announced themselves (EIP-6963). */
export function WalletPicker() {
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    setWalletChooser(
      (wallets) =>
        new Promise<string>((resolve, reject) => {
          setPending({ wallets, resolve, reject });
        }),
    );
    return () => setWalletChooser(undefined);
  }, []);

  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      pending.reject(new Error('No wallet selected.'));
      setPending(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending]);

  if (!pending) return null;

  const pick = (uuid: string) => {
    pending.resolve(uuid);
    setPending(null);
  };
  const cancel = () => {
    pending.reject(new Error('No wallet selected.'));
    setPending(null);
  };

  return (
    <div className="modal-backdrop" onClick={cancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-picker-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="wallet-picker-title">Choose a wallet</h2>
        <p className="muted">Pick the wallet that holds the owner key.</p>
        <ul className="wallet-list">
          {pending.wallets.map((w) => (
            <li key={w.uuid}>
              <button type="button" className="wallet-option" onClick={() => pick(w.uuid)}>
                <img src={w.icon} alt="" width={28} height={28} />
                <span>{w.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="modal-cancel" onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
