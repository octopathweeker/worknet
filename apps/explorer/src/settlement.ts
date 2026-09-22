import { formatUnits } from 'viem';
// Partial rewards may be smaller than a cent. Preserve every USDC base unit.
export function settlementMoney(amount: string): string { return formatUnits(BigInt(amount), 6); }
