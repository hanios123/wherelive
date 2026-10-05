/** A list that starts a fresh pass every time it is iterated, so a query built on it can run more than once. */
export function lazyList<V>(generate: () => Iterator<V>): Iterable<V> {
  return { [Symbol.iterator]: generate };
}

/** Every pair, left list outermost: the order a nested `for` produces. */
export function* pairsOf<A, B>(left: readonly A[], right: readonly B[]): Generator<[A, B], void, undefined> {
  for (const a of left) for (const b of right) yield [a, b];
}

/** Every combination of the named lists, first key outermost. Each row is a new object. */
export function* combinationsOf(
  lists: Readonly<Record<string, readonly unknown[]>>,
  keys: readonly string[] = Object.keys(lists),
  index = 0,
  current: Record<string, unknown> = {},
): Generator<Record<string, unknown>, void, undefined> {
  if (index === keys.length) {
    yield { ...current };
    return;
  }
  const key = keys[index] as string;
  for (const value of lists[key] as readonly unknown[]) {
    current[key] = value;
    yield* combinationsOf(lists, keys, index + 1, current);
  }
}
