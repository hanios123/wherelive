import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ListenError, firestoreBackend, schema } from '../src';
import type { FirestoreTransport } from '../src/transport';
import { MemoryFirestoreTransport } from '../src/testing';
import { definition, flush } from './fixtures';

let transport: MemoryFirestoreTransport;
let db: ReturnType<typeof makeDb>;
const makeDb = (t: FirestoreTransport) => schema(definition, firestoreBackend(t));

const ann = { name: 'Ann', age: 12, tier: 'gold', tags: ['floor'], contact: { email: 'ann@example.test', phone: '555-0101' }, note: 'x' };
const bob = { name: 'Bob', age: 14, tier: 'silver', tags: [], contact: { email: 'bob@example.test', phone: '555-0102' }, note: 'y' };
const cy = { name: 'Cy', age: 13, tier: 'gold', tags: ['floor', 'beam'], contact: { email: 'cy@example.test', phone: '555-0103' }, note: 'z' };

beforeEach(() => {
  transport = new MemoryFirestoreTransport();
  transport.set('customers/1', ann);
  transport.set('customers/2', bob);
  transport.set('customers/3', cy);
  db = makeDb(transport);
});

describe('a document: an event whose selected fields did not change is dropped', () => {
  it('delivers the selected attributes first, then only what changed', () => {
    const changes: unknown[] = [];
    db.customers('1')
      .select('name', 'age')
      .listen(change => changes.push(change));
    expect(changes).toEqual([
      { attribute: 'name', value: 'Ann' },
      { attribute: 'age', value: 12 },
    ]);

    changes.length = 0;
    transport.set('customers/1', { ...ann, note: 'changed' }); // the server still sends a snapshot
    expect(changes).toEqual([]);

    transport.set('customers/1', { ...ann, note: 'changed', age: 13 });
    expect(changes).toEqual([{ attribute: 'age', value: 13 }]);
  });

  it('the server really does notify on the field that was not selected', () => {
    const raw = vi.fn();
    transport.onDocument('customers/1', raw, () => {});
    raw.mockClear();
    transport.set('customers/1', { ...ann, note: 'changed' });
    expect(raw).toHaveBeenCalledOnce(); // so dropping it is the library's job, and it is done
  });

  it('contact.* reports only the field that changed, and a removed field as undefined', () => {
    const changes: any[] = [];
    db.customers('1')
      .select('contact.*')
      .listen(change => changes.push(change));
    expect(changes).toEqual([
      { attribute: 'contact.email', value: 'ann@example.test' },
      { attribute: 'contact.phone', value: '555-0101' },
    ]);
    changes.length = 0;
    transport.set('customers/1', { ...ann, contact: { email: 'ann.new@example.test', phone: '555-0101' } });
    expect(changes).toEqual([{ attribute: 'contact.email', value: 'ann.new@example.test' }]);
    changes.length = 0;
    transport.set('customers/1', { ...ann, contact: { email: 'ann.new@example.test' } });
    expect(changes).toEqual([{ attribute: 'contact.phone', value: undefined }]);
  });

  it('the whole document arrives once and again only when something in it changed', () => {
    const seen: unknown[] = [];
    db.customers('1').listen(customer => seen.push(customer));
    expect(seen).toEqual([ann]);
    transport.set('customers/1', { ...ann });
    expect(seen).toHaveLength(1);
    transport.set('customers/1', { ...ann, note: 'changed' });
    expect(seen).toHaveLength(2);
  });

  it('a document that does not exist arrives as undefined, then when it is created, then when it is deleted', () => {
    const seen: unknown[] = [];
    db.customers('9').listen(customer => seen.push(customer));
    transport.set('customers/9', ann);
    transport.delete('customers/9');
    expect(seen).toEqual([undefined, ann, undefined]);
  });

  it('a selected attribute of a missing document arrives as undefined', () => {
    const changes: unknown[] = [];
    db.customers('9')
      .select('name')
      .listen(change => changes.push(change));
    expect(changes).toEqual([{ attribute: 'name', value: undefined }]);
  });

  it('compares values that carry their own isEqual, as Firestore Timestamps do', () => {
    class Stamp {
      constructor(readonly seconds: number) {}
      isEqual(other: Stamp) {
        return other.seconds === this.seconds;
      }
    }
    const events: Array<(data: any) => void> = [];
    const custom = schema(
      definition,
      firestoreBackend({
        onDocument: (_path, next) => (events.push(next), () => {}),
        onCollection: () => () => {},
        getDocument: async () => undefined,
        getCollection: async () => [],
      }),
    );
    const changes: unknown[] = [];
    custom.customers('1').select('name', 'age').listen(change => changes.push(change));
    const emit = events[0]!;
    emit({ name: new Stamp(1), age: 1 });
    emit({ name: new Stamp(1), age: 1 }); // equal by isEqual, different instance
    emit({ name: new Stamp(2), age: 1 });
    expect(changes).toHaveLength(2 + 1);
  });
});

describe('a list', () => {
  const rows = (build = db.customers.where('tier', '==', 'gold').select('name', 'age')) => {
    const changes: any[] = [];
    const stop = build.listen(change => changes.push(change));
    return { changes, stop };
  };

  it('sends the equality to Firestore and delivers each row', () => {
    const { changes } = rows();
    expect(changes).toEqual([
      { key: '1', attribute: 'name', value: 'Ann' },
      { key: '1', attribute: 'age', value: 12 },
      { key: '3', attribute: 'name', value: 'Cy' },
      { key: '3', attribute: 'age', value: 13 },
    ]);
  });

  it('drops a snapshot whose selected fields did not change, per row', () => {
    const { changes } = rows();
    changes.length = 0;
    transport.set('customers/1', { ...ann, note: 'changed' });
    transport.set('customers/3', { ...cy, note: 'changed' });
    expect(changes).toEqual([]);
    transport.set('customers/3', { ...cy, age: 14 });
    expect(changes).toEqual([{ key: '3', attribute: 'age', value: 14 }]);
  });

  it('a row that starts to match arrives, and a row that stops matching, or is deleted, is removed', () => {
    const { changes } = rows();
    changes.length = 0;
    transport.set('customers/2', { ...bob, tier: 'gold' });
    expect(changes).toEqual([
      { key: '2', attribute: 'name', value: 'Bob' },
      { key: '2', attribute: 'age', value: 14 },
    ]);
    changes.length = 0;
    transport.set('customers/1', { ...ann, tier: 'silver' });
    transport.delete('customers/3');
    expect(changes).toEqual([
      { key: '1', attribute: '*', value: undefined, removed: true },
      { key: '3', attribute: '*', value: undefined, removed: true },
    ]);
  });

  it('runs a clause Firestore cannot run on the rows that arrive, and says so by not sending it', () => {
    const changes: any[] = [];
    makeDb(transport)
      .customers.where('tier', '==', 'gold')
      .where(customer => customer.age >= 13)
      .select('name')
      .listen(change => changes.push(change));
    expect(transport.queryLog.map(entry => entry.query.where)).toEqual([[{ field: 'tier', op: '==', value: 'gold' }]]);
    expect(changes).toEqual([{ key: '3', attribute: 'name', value: 'Cy' }]);

    changes.length = 0;
    transport.set('customers/1', { ...ann, age: 13 }); // now passes the local check
    expect(changes).toEqual([{ key: '1', attribute: 'name', value: 'Ann' }]);
    transport.set('customers/3', { ...cy, age: 1 }); // now fails it
    expect(changes[changes.length - 1]).toEqual({ key: '3', attribute: '*', value: undefined, removed: true });
  });

  it('translates comparisons and whereIncludes to Firestore operators', () => {
    const changes: any[] = [];
    makeDb(transport)
      .customers.where('age', '>=', 13)
      .where('tier', '!=', 'silver')
      .whereIncludes('tags', 'beam')
      .select('name')
      .listen(change => changes.push(change));
    expect(transport.queryLog[0]!.query.where).toEqual([
      { field: 'age', op: '>=', value: 13 },
      { field: 'tier', op: '!=', value: 'silver' },
      { field: 'tags', op: 'array-contains', value: 'beam' },
    ]);
    expect(changes).toEqual([{ key: '3', attribute: 'name', value: 'Cy' }]);
  });

  it('a predicate that throws fails the listen instead of crashing the snapshot handler', () => {
    const onError = vi.fn();
    db.customers
      .where(() => {
        throw new Error('bad check');
      })
      .select('name')
      .listen(() => {}, 'x', onError);
    expect(onError.mock.calls[0]![0].message).toBe('bad check');
    expect(transport.listenerCount).toBe(0);
  });
});

describe('one connection, and it stops', () => {
  it('shares across callers, ignoring the order of where clauses and of selected names', () => {
    const a = db.customers.where('tier', '==', 'gold').where('age', '>', 1).select('name', 'age').listen(() => {});
    const b = db.customers.where('age', '>', 1).where('tier', '==', 'gold').select('age', 'name').listen(() => {});
    expect(transport.listenerCount).toBe(1);
    a();
    expect(transport.listenerCount).toBe(1);
    b();
    expect(transport.listenerCount).toBe(0);
  });

  it('a different value does not share', () => {
    db.customers.where('tier', '==', 'gold').listen(() => {});
    db.customers.where('tier', '==', 'silver').listen(() => {});
    expect(transport.listenerCount).toBe(2);
  });

  it('a check shares only with the very same function', () => {
    const check = (customer: { age: number }) => customer.age > 1;
    db.customers.where(check).listen(() => {});
    db.customers.where(check).listen(() => {});
    expect(transport.listenerCount).toBe(1);
    db.customers.where(customer => customer.age > 1).listen(() => {});
    expect(transport.listenerCount).toBe(2);
  });

  it('a late joiner is replayed the current rows, and the document listener is shared too', async () => {
    const first: unknown[] = [];
    db.customers('1').select('name').listen(change => first.push(change));
    transport.set('customers/1', { ...ann, name: 'Anna' });
    const late: unknown[] = [];
    db.customers('1').select('name').listen(change => late.push(change));
    await flush();
    expect(late).toEqual([{ attribute: 'name', value: 'Anna' }]);
    expect(transport.listenerCount).toBe(1);
  });
});

describe('permission errors stay named', () => {
  it('a denied document and a denied list name the caller', () => {
    transport.deny('customers');
    const one = vi.fn();
    const many = vi.fn();
    db.customers('1').listen(() => {}, 'connectToCustomer', one);
    db.customers.select('name').listen(() => {}, 'connectToCustomers', many);
    const single = one.mock.calls[0]![0] as ListenError;
    expect(single).toBeInstanceOf(ListenError);
    expect(single.message).toBe(
      'PERMISSION_DENIED: Permission denied (listen --- connectToCustomer): Missing or insufficient permissions. --- customers/1',
    );
    expect((many.mock.calls[0]![0] as ListenError).identifier).toBe('connectToCustomers');
    expect((many.mock.calls[0]![0] as ListenError).path).toBe('customers');
  });

  it('a shared connection keeps each caller\'s identifier when the denial arrives', () => {
    const errorsA = vi.fn();
    const errorsB = vi.fn();
    db.customers('1').listen(() => {}, 'screenA', errorsA);
    db.customers('1').listen(() => {}, 'screenB', errorsB);
    transport.deny('customers/1');
    expect((errorsA.mock.calls[0]![0] as ListenError).identifier).toBe('screenA');
    expect((errorsB.mock.calls[0]![0] as ListenError).identifier).toBe('screenB');
    expect(transport.listenerCount).toBe(0);
  });
});
