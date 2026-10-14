import {
  concat,
  encodeAbiParameters,
  numberToHex,
  pad,
  toFunctionSelector,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import type { Call } from './calls.ts';

/** ERC-4337 v0.7 packed user operation, as the EntryPoint takes it. */
export interface PackedUserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

export interface GasSettings {
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  preVerificationGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
}

export const SignerMode = { Owner: 0, Session: 1, SessionWithOwnerApproval: 2 } as const;

const EXECUTE_USER_OP = toFunctionSelector(
  'function executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)',
);

const CALLS_TUPLE = [
  {
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
  },
] as const;

/** `executeUserOp.selector | abi.encode(Call[])`: the call data an Purser user operation carries. */
export function encodeCalls(calls: readonly Call[]): Hex {
  return concat([EXECUTE_USER_OP, encodeAbiParameters(CALLS_TUPLE, [calls.map((c) => ({ ...c }))])]);
}

export function packUint128s(high: bigint, low: bigint): Hex {
  return concat([pad(numberToHex(high), { size: 16 }), pad(numberToHex(low), { size: 16 })]);
}

export function buildUserOp(args: {
  sender: Address;
  nonce: bigint;
  calls: readonly Call[];
  gas: GasSettings;
  initCode?: Hex;
}): PackedUserOperation {
  return {
    sender: args.sender,
    nonce: args.nonce,
    initCode: args.initCode ?? '0x',
    callData: encodeCalls(args.calls),
    accountGasLimits: packUint128s(args.gas.verificationGasLimit, args.gas.callGasLimit),
    preVerificationGas: args.gas.preVerificationGas,
    gasFees: packUint128s(args.gas.maxPriorityFeePerGas, args.gas.maxFeePerGas),
    paymasterAndData: '0x',
    signature: '0x',
  };
}

/** EIP-191 signature over the user operation hash, as PurserAccount expects. */
export function signHash(signer: LocalAccount, userOpHash: Hex): Promise<Hex> {
  if (!signer.signMessage) throw new Error('signer cannot sign messages');
  return signer.signMessage({ message: { raw: userOpHash } });
}

export function ownerSignature(sig: Hex): Hex {
  return concat([numberToHex(SignerMode.Owner, { size: 1 }), sig]);
}

export function sessionSignature(key: Address, sig: Hex): Hex {
  return concat([numberToHex(SignerMode.Session, { size: 1 }), key, sig]);
}

export function approvedSignature(key: Address, sessionSig: Hex, ownerSig: Hex): Hex {
  return concat([numberToHex(SignerMode.SessionWithOwnerApproval, { size: 1 }), key, sessionSig, ownerSig]);
}

/** Unpacks a user operation into the JSON-RPC shape bundlers accept (eth_sendUserOperation, v0.7). */
export function toRpcUserOp(op: PackedUserOperation): Record<string, Hex | null> {
  const hi = (h: Hex) => BigInt(`0x${h.slice(2, 34)}`);
  const lo = (h: Hex) => BigInt(`0x${h.slice(34, 66)}`);
  const hex = (n: bigint) => numberToHex(n);
  const hasInit = op.initCode !== '0x';
  return {
    sender: op.sender,
    nonce: hex(op.nonce),
    factory: hasInit ? (`0x${op.initCode.slice(2, 42)}` as Hex) : null,
    factoryData: hasInit ? (`0x${op.initCode.slice(42)}` as Hex) : null,
    callData: op.callData,
    verificationGasLimit: hex(hi(op.accountGasLimits)),
    callGasLimit: hex(lo(op.accountGasLimits)),
    preVerificationGas: hex(op.preVerificationGas),
    maxPriorityFeePerGas: hex(hi(op.gasFees)),
    maxFeePerGas: hex(lo(op.gasFees)),
    signature: op.signature,
  };
}
