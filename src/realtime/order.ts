/**
 * How Realtime Database orders things, which is not how JavaScript does. Keys that look like 32-bit
 * integers come first, in numeric order, then the other keys as text. Values order by kind: missing
 * and null, false, true, numbers, strings, then objects. It matters because an ordered query must agree
 * with the local sort on every row it returns.
 */
const INTEGER_KEY = /^(?:0|-?[1-9]\d*)$/;
const isIntegerKey = (key: string): boolean => INTEGER_KEY.test(key) && Math.abs(Number(key)) <= 2147483647;

export function compareKeys(a: string, b: string): number {
  const integerA = isIntegerKey(a);
  const integerB = isIntegerKey(b);
  if (integerA && integerB) return Number(a) - Number(b);
  if (integerA) return -1;
  if (integerB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function kind(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (value === false) return 1;
  if (value === true) return 2;
  if (typeof value === 'number') return 3;
  if (typeof value === 'string') return 4;
  return 5;
}

export function compareValues(a: unknown, b: unknown): number {
  const kindA = kind(a);
  const kindB = kind(b);
  if (kindA !== kindB) return kindA - kindB;
  if (kindA === 3) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (kindA === 4) return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  return 0;
}
