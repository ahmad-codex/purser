import { decodeAbiParameters, encodeErrorResult, parseEther, size, slice, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  purserAccountAbi,
  approvedSignature,
  buildUserOp,
  contractCall,
  decodePolicyError,
  encodeCalls,
  entryPointAbi,
  erc20Transfer,
  ethTransfer,
  ownerSignature,
  sessionSignature,
  toRpcUserOp,
} from '../src/index.ts';

const merchant = '0x000000000000000000000000000000000000bEEF';
const token = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const sig = `0x${'11'.repeat(65)}` as Hex;

describe('calls', () => {
  it('builds ETH, ERC-20 and contract calls', () => {
    expect(ethTransfer(merchant, 1n)).toEqual({ target: merchant, value: 1n, data: '0x' });
    expect(erc20Transfer(token, merchant, 5n).data.slice(0, 10)).toBe('0xa9059cbb');
    const buy = contractCall(merchant, 'buy(uint256)', [7n], parseEther('0.1'));
    expect(buy.value).toBe(parseEther('0.1'));
    expect(buy.data.length).toBe(2 + 8 + 64);
  });

  it('encodes calls behind the executeUserOp selector', () => {
    const data = encodeCalls([ethTransfer(merchant, 3n)]);
    expect(slice(data, 0, 4)).toBe('0x8dd7712f');
    const [decoded] = decodeAbiParameters(
      [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }],
      slice(data, 4),
    );
    expect(decoded).toEqual([[merchant, 3n, '0x']]);
  });
});

describe('signatures', () => {
  const key = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

  it('packs the three signer modes with the expected lengths', () => {
    expect(size(ownerSignature(sig))).toBe(66);
    expect(size(sessionSignature(key.address, sig))).toBe(86);
    expect(size(approvedSignature(key.address, sig, sig))).toBe(151);
    expect(slice(sessionSignature(key.address, sig), 0, 1)).toBe('0x01');
    expect(slice(approvedSignature(key.address, sig, sig), 1, 21).toLowerCase()).toBe(key.address.toLowerCase());
  });
});

describe('user operations', () => {
  it('packs gas limits and fees and unpacks them for bundlers', () => {
    const op = buildUserOp({
      sender: merchant,
      nonce: 5n,
      calls: [ethTransfer(merchant, 1n)],
      gas: { verificationGasLimit: 100n, callGasLimit: 200n, preVerificationGas: 300n, maxPriorityFeePerGas: 4n, maxFeePerGas: 5n },
    });
    expect(size(op.accountGasLimits)).toBe(32);
    const rpc = toRpcUserOp(op);
    expect(rpc.verificationGasLimit).toBe('0x64');
    expect(rpc.callGasLimit).toBe('0xc8');
    expect(rpc.maxPriorityFeePerGas).toBe('0x4');
    expect(rpc.maxFeePerGas).toBe('0x5');
    expect(rpc.factory).toBeNull();
  });
});

describe('errors', () => {
  it('explains budget errors and marks them approvable', () => {
    const data = encodeErrorResult({
      abi: purserAccountAbi,
      errorName: 'OverPeriodBudget',
      args: ['0x0000000000000000000000000000000000000000', parseEther('0.2'), parseEther('0.05')],
    });
    const err = decodePolicyError(data)!;
    expect(err.name).toBe('OverPeriodBudget');
    expect(err.approvable).toBe(true);
    expect(err.message).toContain('0.2 ETH');
    expect(err.message).toContain('0.05 ETH');
  });

  it('unwraps errors that the EntryPoint wraps during validation', () => {
    const inner = encodeErrorResult({ abi: purserAccountAbi, errorName: 'CallNotAllowed', args: [merchant, '0x00000000'] });
    const outer = encodeErrorResult({ abi: entryPointAbi, errorName: 'FailedOpWithRevert', args: [0n, 'AA23 reverted', inner] });
    const err = decodePolicyError(outer)!;
    expect(err.name).toBe('CallNotAllowed');
    expect(err.approvable).toBe(false);
    expect(err.message).toBe(`The agent is not allowed to send ETH to ${merchant}.`);
  });

  it('returns undefined for empty or unknown data', () => {
    expect(decodePolicyError('0x')).toBeUndefined();
    expect(decodePolicyError('0xdeadbeef')).toBeUndefined();
  });
});
