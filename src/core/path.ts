/** Reads one field, or one dotted path, from a value. */
export type PathReader = (value: unknown) => unknown;

/**
 * A function that reads `'city'` or `'customer.address.city'` from a value. A missing step is `undefined`.
 * Build it once and call it for every row: the path is split here and not again.
 */
export function pathReader(path: string): PathReader {
  if (!path.includes('.')) return value => (value === null || value === undefined ? undefined : (value as Record<string, unknown>)[path]);
  const keys = path.split('.');
  return value => {
    let current = value;
    for (const key of keys) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  };
}

/** Paths are the names in a schema, so there are few. The cap only guards against a caller who builds them from data. */
const MAX_CACHED_PATHS = 500;
const readers = new Map<string, PathReader>();

/** Read a field, or a dotted path to a nested field: `'city'`, `'customer.address.city'`. A missing step is `undefined`. */
export function getPath(value: unknown, path: string): unknown {
  let read = readers.get(path);
  if (!read) {
    if (readers.size >= MAX_CACHED_PATHS) readers.clear();
    readers.set(path, (read = pathReader(path)));
  }
  return read(value);
}
