const hasToMillis = (value: unknown): value is { toMillis(): number } =>
  typeof value === 'object' && value !== null && typeof (value as { toMillis?: unknown }).toMillis === 'function';

/** Types sort in a fixed order, the way Firestore orders them: missing/null, booleans, numbers, dates, strings, the rest. */
function rank(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number' || typeof value === 'bigint') return 2;
  if (value instanceof Date || hasToMillis(value)) return 3;
  if (typeof value === 'string') return 4;
  return 5;
}

/** A `Date`, or a value that carries `toMillis()` the way a Firestore `Timestamp` does. */
export const isTimeish = (value: unknown): boolean => value instanceof Date || hasToMillis(value);

export const millisOf = (value: unknown): number => (value instanceof Date ? value.getTime() : (value as { toMillis(): number }).toMillis());

/**
 * Order two values. Missing and `null` come first, then booleans, numbers,
 * dates, strings. Strings compare by code unit unless a collator is given.
 */
export function compareValues(a: unknown, b: unknown, collator?: Intl.Collator): number {
  const rankA = rank(a);
  const rankB = rank(b);
  if (rankA !== rankB) return rankA - rankB;
  switch (rankA) {
    case 1:
      return Number(a) - Number(b);
    case 2:
      return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
    case 3:
      return millisOf(a) - millisOf(b);
    case 4:
      return collator ? collator.compare(a as string, b as string) : (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
    default:
      return 0;
  }
}

/**
 * How two values order, when a database would compare them: both present and of the same
 * kind (two numbers, two strings, two dates). A number and a string, or a missing value,
 * do not compare, so no range filter matches them. Dates and Timestamps compare by time.
 */
export function comparableOrder(a: unknown, b: unknown): number | undefined {
  const kind = rank(a);
  if (kind === 0 || kind === 5 || kind !== rank(b)) return undefined;
  return compareValues(a, b);
}

/** A string that is equal for equal values, so rows can be de-duplicated and grouped. Object keys are sorted. */
export function stableKey(value: unknown): string {
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Object.is(value, -0) ? '0' : String(value);
    case 'boolean':
      return value ? 't' : 'f';
    case 'bigint':
      return `${value}i`;
  }
  if (isTimeish(value)) return `d${millisOf(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableKey(record[key])}`)
      .join(',')}}`;
  }
  return `?${String(value)}`;
}
