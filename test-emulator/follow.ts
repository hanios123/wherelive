const active: Array<() => void> = [];

/** Stop every list a test started, before its connection closes. */
export function stopAll(): void {
  for (const stop of active.splice(0)) stop();
}

export type Change = { key?: string; attribute: string; value: unknown; removed?: boolean };

/** What a caller who keeps one row per key ends up holding, and every event it was sent. */
export function follow(listen: (next: (change: Change) => void) => () => void) {
  const rows = new Map<string, Record<string, unknown>>();
  const events: Change[] = [];
  const stop = listen(change => {
    events.push(change);
    const key = change.key ?? '';
    if (change.removed) rows.delete(key);
    else rows.set(key, { ...rows.get(key), [change.attribute]: change.value });
  });
  active.push(stop);
  return { rows, events, stop, snapshot: () => Object.fromEntries(rows) };
}
