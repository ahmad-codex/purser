import { BaseError, ContractFunctionRevertedError, decodeErrorResult, formatEther, type Hex } from 'viem';
import { entryPointAbi, purserAccountAbi } from './abi.ts';

/** An Purser policy error, decoded from revert data. */
export interface PolicyError {
  name: string;
  args: readonly unknown[];
  /** Plain-language explanation an agent or a person can act on. */
  message: string;
  /** True when an owner approval can unblock it (budget or per-transaction cap). */
  approvable: boolean;
}

const APPROVABLE = new Set(['OverTransactionLimit', 'OverPeriodBudget']);

function amount(token: unknown, value: unknown): string {
  const n = typeof value === 'bigint' ? value : 0n;
  return token === '0x0000000000000000000000000000000000000000' ? `${formatEther(n)} ETH` : `${n} units of ${token}`;
}

function describe(name: string, args: readonly unknown[]): string {
  switch (name) {
    case 'OverTransactionLimit':
      return `This payment (${amount(args[0], args[1])}) is over the per-transaction limit of ${amount(args[0], args[2])}.`;
    case 'OverPeriodBudget':
      return `This needs ${amount(args[0], args[1])} but only ${amount(args[0], args[2])} is left in the current budget period.`;
    case 'CallNotAllowed':
      return String(args[1]) === '0x00000000'
        ? `The agent is not allowed to send ETH to ${args[0]}.`
        : `The agent is not allowed to call function ${args[1]} on ${args[0]}.`;
    case 'TokenNotAllowed':
      return `The agent has no budget for token ${args[0]}.`;
    case 'SessionNotActive':
      return 'The agent key is revoked, expired or not valid yet.';
    case 'AccountFrozen':
      return 'The owner has frozen the account. No agent can act until it is unfrozen.';
    case 'SelfCallNotAllowed':
      return 'Agents cannot change the account itself.';
    default:
      return name;
  }
}

/** Decodes Purser and EntryPoint revert data, including errors wrapped in FailedOpWithRevert. */
export function decodePolicyError(data: Hex | undefined): PolicyError | undefined {
  if (!data || data === '0x') return undefined;
  try {
    const decoded = decodeErrorResult({ abi: [...purserAccountAbi, ...entryPointAbi], data });
    if (decoded.errorName === 'FailedOpWithRevert') {
      const inner = decodePolicyError(decoded.args[2] as Hex);
      if (inner) return inner;
    }
    if (decoded.errorName === 'FailedOp' || decoded.errorName === 'FailedOpWithRevert') {
      const reason = String(decoded.args[1]);
      return { name: decoded.errorName, args: decoded.args, message: reason, approvable: false };
    }
    const args = decoded.args ?? [];
    return { name: decoded.errorName, args, message: describe(decoded.errorName, args), approvable: APPROVABLE.has(decoded.errorName) };
  } catch {
    return undefined;
  }
}

/** Pulls revert data out of a viem error, then decodes it. */
export function policyErrorFrom(err: unknown): PolicyError | undefined {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.raw) return decodePolicyError(reverted.raw);
    const withData = err.walk((e) => typeof (e as { data?: unknown }).data === 'string') as { data?: Hex } | null;
    if (withData?.data) return decodePolicyError(withData.data);
  }
  return undefined;
}
