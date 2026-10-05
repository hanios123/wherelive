import type { Unsubscribe } from '../core/types';
import { nameListenError } from './errors';
import type { ChangeEvent, Subscriber } from './types';

/** What a backend gets to push into. */
export interface Sink {
  emit(change: ChangeEvent): void;
  fail(error: unknown): void;
}

interface Registration {
  readonly subscriber: Subscriber;
  active: boolean;
  /** A late joiner waits for its replay so it never sees an older value after a newer one. */
  replaying: boolean;
}

interface Entry {
  readonly key: string;
  readonly path: string;
  readonly records: Set<Registration>;
  /** Latest change per row, per attribute. Replayed to late joiners. */
  readonly latest: Map<string, Map<string, ChangeEvent>>;
  close: Unsubscribe | undefined;
  dead: boolean;
}

/** Errors thrown by a caller's own error handler must not vanish and must not break the other callers. */
const surface = (error: unknown): void => {
  queueMicrotask(() => {
    throw error;
  });
};

/**
 * One backend connection per canonical key. Every caller gets its own
 * unsubscribe. The last one detaches the connection.
 */
export class ListenerRegistry {
  private readonly entries = new Map<string, Entry>();

  /** How many connections are open. */
  get connections(): number {
    return this.entries.size;
  }

  subscribe(key: string, path: string, open: (sink: Sink) => Unsubscribe, subscriber: Subscriber): Unsubscribe {
    let entry = this.entries.get(key);
    const record: Registration = { subscriber, active: true, replaying: false };

    if (entry) {
      record.replaying = true;
      entry.records.add(record);
      this.scheduleReplay(entry, record);
    } else {
      const fresh: Entry = { key, path, records: new Set([record]), latest: new Map(), close: undefined, dead: false };
      entry = fresh;
      this.entries.set(key, fresh);
      const sink: Sink = { emit: change => this.emit(fresh, change), fail: error => this.fail(fresh, error) };
      try {
        const close = open(sink);
        if (fresh.dead) close();
        else fresh.close = close;
      } catch (error) {
        this.fail(fresh, error);
      }
    }

    const owner = entry;
    return () => {
      if (!record.active) return;
      record.active = false;
      owner.records.delete(record);
      if (owner.records.size === 0) this.detach(owner);
    };
  }

  private emit(entry: Entry, change: ChangeEvent): void {
    if (entry.dead) return;
    const frozen = Object.freeze({ ...change });
    const rowKey = frozen.key ?? '';
    if (frozen.removed) {
      entry.latest.delete(rowKey);
    } else {
      let row = entry.latest.get(rowKey);
      if (!row) entry.latest.set(rowKey, (row = new Map()));
      row.set(frozen.attribute, frozen);
    }
    for (const record of [...entry.records]) {
      if (record.active && !record.replaying) this.deliver(entry, record, frozen);
    }
  }

  private scheduleReplay(entry: Entry, record: Registration): void {
    queueMicrotask(() => {
      record.replaying = false;
      if (!record.active || entry.dead) return;
      for (const row of [...entry.latest.values()]) {
        for (const change of [...row.values()]) {
          if (!record.active || entry.dead) return;
          this.deliver(entry, record, change);
        }
      }
    });
  }

  private deliver(entry: Entry, record: Registration, change: ChangeEvent): void {
    try {
      record.subscriber.next(change);
    } catch (error) {
      this.report(entry, record, error);
    }
  }

  private report(entry: Entry, record: Registration, error: unknown): void {
    try {
      record.subscriber.error(nameListenError(error, { identifier: record.subscriber.identifier, path: entry.path }));
    } catch (handlerError) {
      surface(handlerError);
    }
  }

  private fail(entry: Entry, error: unknown): void {
    if (entry.dead) return;
    const records = [...entry.records];
    entry.records.clear();
    this.detach(entry);
    for (const record of records) {
      if (!record.active) continue;
      record.active = false;
      this.report(entry, record, error);
    }
  }

  private detach(entry: Entry): void {
    if (entry.dead) return;
    entry.dead = true;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    const close = entry.close;
    entry.close = undefined;
    try {
      close?.();
    } catch (error) {
      surface(error);
    }
  }
}
