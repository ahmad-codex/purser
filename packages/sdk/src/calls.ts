import { encodeFunctionData, erc20Abi, parseAbiItem, type AbiFunction, type Address, type Hex } from 'viem';

/** One call made by a Purser account. */
export interface Call {
  target: Address;
  value: bigint;
  data: Hex;
}

/** Sends native ETH (wei) to an address. */
export function ethTransfer(to: Address, value: bigint): Call {
  return { target: to, value, data: '0x' };
}

/** Transfers ERC-20 tokens (base units) from the account. */
export function erc20Transfer(token: Address, to: Address, amount: bigint): Call {
  return {
    target: token,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
  };
}

/** Approves a spender for ERC-20 tokens. Purser counts approvals as spending. */
export function erc20Approve(token: Address, spender: Address, amount: bigint): Call {
  return {
    target: token,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
  };
}

/**
 * Calls a contract function given its human-readable signature, for example
 * `contractCall(shop, 'buy(uint256)', [42n], parseEther('0.01'))`.
 */
export function contractCall(target: Address, signature: string, args: readonly unknown[] = [], value = 0n): Call {
  const item = parseAbiItem(`function ${signature.replace(/^function\s+/, '')}`) as AbiFunction;
  return {
    target,
    value,
    data: encodeFunctionData({ abi: [item], functionName: item.name, args: args as never }),
  };
}
