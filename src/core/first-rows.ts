/**
 * The `count` rows that come first under `compare`, in order, without sorting the rest. It returns
 * exactly what a stable full sort followed by `slice(0, count)` returns: rows that compare equal
 * keep the order they came in. With `fromEnd` it returns the rows that come last, as `slice(-count)` would.
 *
 * A heap of the best `count` rows seen so far makes this `O(n log count)`. Most rows lose to the
 * worst row kept, and that takes one comparison.
 */
export function firstRows<T>(rows: readonly T[], compare: (a: T, b: T) => number, count: number, fromEnd = false): T[] {
  const sign = fromEnd ? -1 : 1;
  const order = (a: number, b: number): number => compare(rows[a] as T, rows[b] as T) || 0;
  // Positions break ties, so no two rows are equal and the answer is the same as a stable sort's.
  const before = (a: number, b: number): boolean => {
    const result = order(a, b);
    return result !== 0 ? result * sign < 0 : (a - b) * sign < 0;
  };

  // A heap whose root is the worst row kept: every row below a parent comes before it.
  const heap: number[] = [];
  const siftUp = (from: number): void => {
    let at = from;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!before(heap[parent] as number, heap[at] as number)) break;
      [heap[parent], heap[at]] = [heap[at] as number, heap[parent] as number];
      at = parent;
    }
  };
  const siftDown = (from: number): void => {
    let at = from;
    for (;;) {
      const left = 2 * at + 1;
      const right = left + 1;
      let worst = at;
      if (left < heap.length && before(heap[worst] as number, heap[left] as number)) worst = left;
      if (right < heap.length && before(heap[worst] as number, heap[right] as number)) worst = right;
      if (worst === at) break;
      [heap[worst], heap[at]] = [heap[at] as number, heap[worst] as number];
      at = worst;
    }
  };

  for (let position = 0; position < rows.length; position++) {
    if (heap.length < count) {
      heap.push(position);
      siftUp(heap.length - 1);
    } else if (before(position, heap[0] as number)) {
      heap[0] = position;
      siftDown(0);
    }
  }
  return heap.sort((a, b) => order(a, b) || a - b).map(position => rows[position] as T);
}
