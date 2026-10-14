import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

function base() {
  for (const k of Object.keys(process.env)) if (k.startsWith('PURSER_')) delete process.env[k];
  process.env.PURSER_ACCOUNT = '0x987f1c0ff71bbb2a644b3e7983403947fec76d66';
  process.env.PURSER_AGENT_PRIVATE_KEY = KEY;
}

describe('loadConfig', () => {
  it('reads the account, address book and tokens from the environment', () => {
    base();
    process.env.PURSER_ADDRESS_BOOK = 'alice=0x000000000000000000000000000000000000beef, bad=nope';
    process.env.PURSER_TOKENS = 'USDC=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
    const c = loadConfig();
    expect(c.account).toBe('0x987F1C0ff71BbB2A644B3e7983403947FEC76D66');
    expect(c.addressBook).toEqual({ alice: '0x000000000000000000000000000000000000bEEF' });
    expect(c.tokens.USDC).toBe('0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9');
    expect(c.port).toBe(8787);
    expect(c.demo).toBe(false);
  });

  it('refuses an owner key outside demo mode', () => {
    base();
    process.env.PURSER_OWNER_PRIVATE_KEY = KEY;
    expect(() => loadConfig()).toThrow(/only allowed with PURSER_DEMO=true/);
  });

  it('requires an account', () => {
    base();
    delete process.env.PURSER_ACCOUNT;
    expect(() => loadConfig()).toThrow(/PURSER_ACCOUNT/);
  });
});
