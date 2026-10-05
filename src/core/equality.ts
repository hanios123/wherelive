import { isTimeish, millisOf } from './compare';

const hasIsEqual = (value: object): value is { isEqual(other: unknown): boolean } =>
  typeof (value as { isEqual?: unknown }).isEqual === 'function';

/**
 * Structural equality for values a database hands back: primitives, plain
 * objects, arrays, and SDK value types. Dates and Timestamp-like values are equal
 * when they are the same instant, whichever kind each is. Other SDK types that
 * carry their own `isEqual` (`GeoPoint`, document references) use it.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b || Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (isTimeish(a) && isTimeish(b)) return millisOf(a) === millisOf(b);
  if (hasIsEqual(a)) return hasIsEqual(b) && a.isEqual(b);
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((value, index) => valuesEqual(value, b[index]));
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(key => key in right && valuesEqual(left[key], right[key]));
}
