import { beforeEach, describe, expect, it, vi } from 'vitest';

// The SDK is mocked: these tests check that the adapters call it the way the SDK is documented to be called,
// and that what comes back is mapped to the transport contract. They do not talk to a Firebase project.
const rtdb = vi.hoisted(() => {
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const stop = () => {
    const fn = vi.fn();
    stops.push(fn);
    return fn;
  };
  return {
    stops,
    ref: vi.fn((database: unknown, path: string) => ({ kind: 'ref', path })),
    query: vi.fn((base: unknown, ...constraints: unknown[]) => ({ kind: 'query', base, constraints })),
    orderByChild: vi.fn((child: string) => ({ orderByChild: child })),
    orderByKey: vi.fn(() => ({ orderByKey: true })),
    startAt: vi.fn((value: unknown) => ({ startAt: value })),
    startAfter: vi.fn((value: unknown) => ({ startAfter: value })),
    endAt: vi.fn((value: unknown) => ({ endAt: value })),
    endBefore: vi.fn((value: unknown) => ({ endBefore: value })),
    limitToFirst: vi.fn((count: number) => ({ limitToFirst: count })),
    limitToLast: vi.fn((count: number) => ({ limitToLast: count })),
    equalTo: vi.fn((value: unknown) => ({ equalTo: value })),
    onValue: vi.fn(() => stop()),
    get: vi.fn(),
    onChildAdded: vi.fn(() => stop()),
    onChildChanged: vi.fn(() => stop()),
    onChildRemoved: vi.fn(() => stop()),
  };
});
vi.mock('firebase/database', () => rtdb);

const fs = vi.hoisted(() => ({
  doc: vi.fn((firestore: unknown, path: string) => ({ kind: 'doc', path })),
  collection: vi.fn((firestore: unknown, path: string) => ({ kind: 'collection', path })),
  collectionGroup: vi.fn((firestore: unknown, id: string) => ({ kind: 'group', path: id })),
  and: vi.fn((...filters: unknown[]) => ({ and: filters })),
  or: vi.fn((...filters: unknown[]) => ({ or: filters })),
  documentId: vi.fn(() => ({ documentId: true })),
  startAt: vi.fn((...values: unknown[]) => ({ startAt: values })),
  startAfter: vi.fn((...values: unknown[]) => ({ startAfter: values })),
  endAt: vi.fn((...values: unknown[]) => ({ endAt: values })),
  endBefore: vi.fn((...values: unknown[]) => ({ endBefore: values })),
  count: vi.fn(() => ({ agg: 'count' })),
  sum: vi.fn((field: string) => ({ agg: 'sum', field })),
  average: vi.fn((field: string) => ({ agg: 'avg', field })),
  getAggregateFromServer: vi.fn(),
  getDocFromServer: vi.fn(),
  getDocFromCache: vi.fn(),
  getDocsFromServer: vi.fn(),
  getDocsFromCache: vi.fn(),
  where: vi.fn((field: string, op: string, value: unknown) => ({ where: [field, op, value] })),
  query: vi.fn((base: unknown, ...constraints: unknown[]) => ({ kind: 'query', base, constraints })),
  onSnapshot: vi.fn(() => vi.fn()),
  orderBy: vi.fn((field: string, direction?: string) => ({ orderBy: [field, direction] })),
  limit: vi.fn((count: number) => ({ limit: count })),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
}));
vi.mock('firebase/firestore', () => fs);

import { firebaseFirestoreTransport, firebaseRealtimeTransport } from '../src/firebase';

const database = { name: 'database' } as never;
const firestore = { name: 'firestore' } as never;
const snapshot = (key: string | null, value: unknown) => ({ key, val: () => value });
/** A Firestore query document. `data` counts how often it was decoded. */
const document = (id: string, data: Record<string, unknown>, path = `users/${id}`) => ({ id, ref: { path }, data: vi.fn(() => data) });

beforeEach(() => {
  vi.clearAllMocks();
  rtdb.stops.length = 0;
});

describe('Realtime Database adapter', () => {
  it('onValue listens at the ref and maps null to undefined', () => {
    const next = vi.fn();
    const error = vi.fn();
    firebaseRealtimeTransport(database).onValue('a/b', next, error);
    expect(rtdb.ref).toHaveBeenCalledWith(database, 'a/b');
    const [source, callback, cancel] = rtdb.onValue.mock.calls[0] as unknown as [unknown, (s: unknown) => void, unknown];
    expect(source).toEqual({ kind: 'ref', path: 'a/b' });
    expect(cancel).toBe(error);
    callback(snapshot('b', null));
    callback(snapshot('b', ['x']));
    expect(next.mock.calls).toEqual([[undefined], [['x']]]);
  });

  it('onValue returns the SDK unsubscribe', () => {
    const stop = firebaseRealtimeTransport(database).onValue('a', vi.fn(), vi.fn());
    stop();
    expect(rtdb.stops[0]).toHaveBeenCalledOnce();
  });

  it('onChildren without a filter listens on the ref and subscribes only to the handlers given', () => {
    const handlers = { added: vi.fn(), removed: vi.fn() };
    firebaseRealtimeTransport(database).onChildren('g', undefined, handlers, vi.fn());
    expect(rtdb.query).not.toHaveBeenCalled();
    expect(rtdb.onChildAdded).toHaveBeenCalledOnce();
    expect(rtdb.onChildRemoved).toHaveBeenCalledOnce();
    expect(rtdb.onChildChanged).not.toHaveBeenCalled();
    const [source, added] = rtdb.onChildAdded.mock.calls[0] as unknown as [unknown, (s: unknown) => void];
    expect(source).toEqual({ kind: 'ref', path: 'g' });
    added(snapshot('1', { name: 'Ann' }));
    added(snapshot('2', null));
    expect(handlers.added.mock.calls).toEqual([['1', { name: 'Ann' }], ['2', undefined]]);
    const [, removed] = rtdb.onChildRemoved.mock.calls[0] as unknown as [unknown, (s: unknown) => void];
    removed(snapshot('1', { name: 'Ann' }));
    expect(handlers.removed).toHaveBeenCalledWith('1');
  });

  it('onChildren with a filter is one orderByChild + equalTo query', () => {
    firebaseRealtimeTransport(database).onChildren('g', { order: { child: 'tier' }, equalTo: 'gold' }, { added: vi.fn() }, vi.fn());
    expect(rtdb.orderByChild).toHaveBeenCalledWith('tier');
    expect(rtdb.equalTo).toHaveBeenCalledWith('gold');
    const [source] = rtdb.onChildAdded.mock.calls[0] as unknown as [{ kind: string; constraints: unknown[] }];
    expect(source.kind).toBe('query');
    expect(source.constraints).toEqual([{ orderByChild: 'tier' }, { equalTo: 'gold' }]);
  });

  it('onChildren maps changed, and its unsubscribe detaches all three', () => {
    const changed = vi.fn();
    const stop = firebaseRealtimeTransport(database).onChildren('g', undefined, { added: vi.fn(), changed, removed: vi.fn() }, vi.fn());
    const [, onChanged] = rtdb.onChildChanged.mock.calls[0] as unknown as [unknown, (s: unknown) => void];
    onChanged(snapshot('1', 5));
    expect(changed).toHaveBeenCalledWith('1', 5);
    stop();
    expect(rtdb.stops).toHaveLength(3);
    for (const fn of rtdb.stops) expect(fn).toHaveBeenCalledOnce();
  });

  it('onChildren detaches what it attached when a later attach throws', () => {
    rtdb.onChildRemoved.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() =>
      firebaseRealtimeTransport(database).onChildren('g', undefined, { added: vi.fn(), changed: vi.fn(), removed: vi.fn() }, vi.fn()),
    ).toThrow('boom');
    expect(rtdb.stops).toHaveLength(2);
    for (const fn of rtdb.stops) expect(fn).toHaveBeenCalledOnce();
  });
});

describe('Firestore adapter', () => {
  it('onDocument maps a missing document to undefined', () => {
    const next = vi.fn();
    const error = vi.fn();
    firebaseFirestoreTransport(firestore).onDocument('users/1', next, error);
    expect(fs.doc).toHaveBeenCalledWith(firestore, 'users/1');
    const [source, callback, cancel] = fs.onSnapshot.mock.calls[0] as unknown as [unknown, (s: unknown) => void, unknown];
    expect(source).toEqual({ kind: 'doc', path: 'users/1' });
    expect(cancel).toBe(error);
    callback({ exists: () => false, data: () => undefined });
    callback({ exists: () => true, data: () => ({ name: 'Ann' }) });
    expect(next.mock.calls).toEqual([[undefined], [{ name: 'Ann' }]]);
  });

  it('onCollection builds a query from the where clauses and maps documents to rows', () => {
    const next = vi.fn();
    firebaseFirestoreTransport(firestore).onCollection(
      'users',
      {
        where: [
          { field: 'tier', op: '==', value: 'gold' },
          { field: 'tags', op: 'array-contains', value: 'floor' },
        ],
        orderBy: [],
      },
      next,
      vi.fn(),
    );
    expect(fs.collection).toHaveBeenCalledWith(firestore, 'users');
    expect(fs.where.mock.calls).toEqual([
      ['tier', '==', 'gold'],
      ['tags', 'array-contains', 'floor'],
    ]);
    const [source, callback] = fs.onSnapshot.mock.calls[0] as unknown as [{ constraints: unknown[] }, (s: unknown) => void];
    // the filters travel as one composite, which is how the SDK mixes them with `or`
    expect(source.constraints).toEqual([{ and: [{ where: ['tier', '==', 'gold'] }, { where: ['tags', 'array-contains', 'floor'] }] }]);
    const docs = [document('a', { name: 'Ann' }), document('b', { name: 'Bob' })];
    callback({ docs, docChanges: () => docs.map(doc => ({ type: 'added', doc })) });
    expect(next).toHaveBeenCalledWith([
      { id: 'a', data: { name: 'Ann' } },
      { id: 'b', data: { name: 'Bob' } },
    ]);
  });

  describe('a live collection decodes only the documents that changed', () => {
    const listen = (group?: boolean) => {
      const next = vi.fn();
      firebaseFirestoreTransport(firestore).onCollection('users', { where: [], orderBy: [], ...(group ? { group: true } : {}) }, next, vi.fn());
      const callback = (fs.onSnapshot.mock.calls[0] as unknown as [unknown, (s: unknown) => void])[1];
      return { next, callback };
    };

    it('the second snapshot decodes the modified document and reuses the rest', () => {
      const { next, callback } = listen();
      const [a, b, c] = [document('a', { n: 1 }), document('b', { n: 2 }), document('c', { n: 3 })];
      callback({ docs: [a, b, c], docChanges: () => [a, b, c].map(doc => ({ type: 'added', doc })) });
      const b2 = document('b', { n: 20 });
      callback({ docs: [a, b2, c], docChanges: () => [{ type: 'modified', doc: b2 }] });
      expect(next).toHaveBeenLastCalledWith([
        { id: 'a', data: { n: 1 } },
        { id: 'b', data: { n: 20 } },
        { id: 'c', data: { n: 3 } },
      ]);
      expect([a.data, b.data, c.data, b2.data].map(read => read.mock.calls.length)).toEqual([1, 1, 1, 1]);
    });

    it('an unchanged snapshot decodes nothing new, and keeps the same data objects', () => {
      const { next, callback } = listen();
      const docs = [document('a', { n: 1 }), document('b', { n: 2 })];
      callback({ docs, docChanges: () => docs.map(doc => ({ type: 'added', doc })) });
      const first = next.mock.calls[0]?.[0] as Array<{ data: unknown }>;
      callback({ docs, docChanges: () => [] });
      const second = next.mock.calls[1]?.[0] as Array<{ data: unknown }>;
      expect(docs.map(doc => doc.data.mock.calls.length)).toEqual([1, 1]);
      expect(second.map(row => row.data)).toEqual(first.map(row => row.data));
      expect(second[0]?.data).toBe(first[0]?.data);
    });

    it('a removed document is forgotten, so it is decoded afresh if it comes back', () => {
      const { next, callback } = listen();
      const [a, b] = [document('a', { n: 1 }), document('b', { n: 2 })];
      callback({ docs: [a, b], docChanges: () => [a, b].map(doc => ({ type: 'added', doc })) });
      callback({ docs: [a], docChanges: () => [{ type: 'removed', doc: b }] });
      expect(next).toHaveBeenLastCalledWith([{ id: 'a', data: { n: 1 } }]);
      const back = document('b', { n: 99 });
      callback({ docs: [a, back], docChanges: () => [{ type: 'added', doc: back }] });
      expect(next).toHaveBeenLastCalledWith([
        { id: 'a', data: { n: 1 } },
        { id: 'b', data: { n: 99 } },
      ]);
    });

    it('a document that was never reported as a change is still decoded once', () => {
      const { next, callback } = listen();
      const a = document('a', { n: 1 });
      callback({ docs: [a], docChanges: () => [] });
      callback({ docs: [a], docChanges: () => [] });
      expect(next).toHaveBeenLastCalledWith([{ id: 'a', data: { n: 1 } }]);
      expect(a.data).toHaveBeenCalledOnce();
    });

    it('in a collection group two documents with one id under different parents stay apart', () => {
      const { next, callback } = listen(true);
      const one = document('a', { owner: 1 }, 'users/1/orders/a');
      const two = document('a', { owner: 2 }, 'users/2/orders/a');
      callback({ docs: [one, two], docChanges: () => [one, two].map(doc => ({ type: 'added', doc })) });
      // a group row carries its full path, which is what tells the two apart
      expect(next).toHaveBeenLastCalledWith([
        { id: 'a', data: { owner: 1 }, path: 'users/1/orders/a' },
        { id: 'a', data: { owner: 2 }, path: 'users/2/orders/a' },
      ]);
      const two2 = document('a', { owner: 22 }, 'users/2/orders/a');
      callback({ docs: [one, two2], docChanges: () => [{ type: 'modified', doc: two2 }] });
      expect(next).toHaveBeenLastCalledWith([
        { id: 'a', data: { owner: 1 }, path: 'users/1/orders/a' },
        { id: 'a', data: { owner: 22 }, path: 'users/2/orders/a' },
      ]);
      expect(one.data).toHaveBeenCalledOnce();
    });
  });

  it('returns the SDK unsubscribe', () => {
    const stop = vi.fn();
    fs.onSnapshot.mockReturnValueOnce(stop);
    firebaseFirestoreTransport(firestore).onCollection('users', { where: [], orderBy: [] }, vi.fn(), vi.fn())();
    expect(stop).toHaveBeenCalledOnce();
  });

  describe('onCollectionChanges reports what the SDK says changed, and nothing else', () => {
    const listen = () => {
      const next = vi.fn();
      const error = vi.fn();
      firebaseFirestoreTransport(firestore).onCollectionChanges?.('users', { where: [{ field: 'tier', op: '==', value: 'gold' }], orderBy: [] }, next, error);
      const [source, callback, cancel] = fs.onSnapshot.mock.calls[0] as unknown as [{ constraints: unknown[] }, (s: unknown) => void, unknown];
      return { next, error, source, callback, cancel };
    };

    it('builds the same query as onCollection, and sends errors to the error handler', () => {
      const { source, error, cancel } = listen();
      expect(source.constraints).toEqual([{ and: [{ where: ['tier', '==', 'gold'] }] }]);
      expect(cancel).toBe(error);
    });

    it('maps added, modified and removed, and decodes only the documents that are not removed', () => {
      const { next, callback } = listen();
      const [a, b, c] = [document('a', { n: 1 }), document('b', { n: 2 }), document('c', { n: 3 })];
      callback({ docChanges: () => [{ type: 'added', doc: a }, { type: 'modified', doc: b }, { type: 'removed', doc: c }] });
      expect(next).toHaveBeenCalledWith([
        { type: 'added', id: 'a', data: { n: 1 } },
        { type: 'modified', id: 'b', data: { n: 2 } },
        { type: 'removed', id: 'c' },
      ]);
      expect(c.data).not.toHaveBeenCalled();
    });

    it('never builds the list of every document: only the changes are read', () => {
      const { next, callback } = listen();
      const snapshot = {
        get docs(): never {
          throw new Error('the snapshot was asked for every document');
        },
        docChanges: () => [{ type: 'modified', doc: document('a', { n: 1 }) }],
      };
      expect(() => callback(snapshot)).not.toThrow();
      expect(next).toHaveBeenCalledOnce();
    });

    it('in a collection group every change carries its full path, removals too, and elsewhere none does', () => {
      const next = vi.fn();
      firebaseFirestoreTransport(firestore).onCollectionChanges?.('orders', { where: [], orderBy: [], group: true }, next, vi.fn());
      const callback = (fs.onSnapshot.mock.calls[0] as unknown as [unknown, (s: unknown) => void])[1];
      const [a, b, c] = [document('a', { n: 1 }, 'users/1/orders/a'), document('a', { n: 2 }, 'users/2/orders/a'), document('c', { n: 3 }, 'users/3/orders/c')];
      callback({ docChanges: () => [{ type: 'added', doc: a }, { type: 'modified', doc: b }, { type: 'removed', doc: c }] });
      expect(next).toHaveBeenCalledWith([
        { type: 'added', id: 'a', path: 'users/1/orders/a', data: { n: 1 } },
        { type: 'modified', id: 'a', path: 'users/2/orders/a', data: { n: 2 } },
        { type: 'removed', id: 'c', path: 'users/3/orders/c' },
      ]);

      fs.onSnapshot.mockClear();
      const plain = listen();
      plain.callback({ docChanges: () => [{ type: 'added', doc: document('x', { n: 1 }) }] });
      expect(plain.next).toHaveBeenCalledWith([{ type: 'added', id: 'x', data: { n: 1 } }]);
    });

    it('an update with no changes is passed on as an empty list', () => {
      const { next, callback } = listen();
      callback({ docChanges: () => [] });
      expect(next).toHaveBeenCalledWith([]);
    });

    it('returns the SDK unsubscribe', () => {
      const stop = vi.fn();
      fs.onSnapshot.mockReturnValueOnce(stop);
      firebaseFirestoreTransport(firestore).onCollectionChanges?.('users', { where: [], orderBy: [] }, vi.fn(), vi.fn())?.();
      expect(stop).toHaveBeenCalledOnce();
    });
  });
});

describe('Realtime Database adapter: one-time reads', () => {
  it('getValue reads the ref once and maps a missing node to undefined', async () => {
    rtdb.get.mockResolvedValueOnce({ val: () => ['a'] }).mockResolvedValueOnce({ val: () => null });
    const transport = firebaseRealtimeTransport(database);
    expect(await transport.getValue('a/b')).toEqual(['a']);
    expect(await transport.getValue('a/b')).toBeUndefined();
    expect(rtdb.get).toHaveBeenCalledWith({ kind: 'ref', path: 'a/b' });
  });

  it('getChildren returns each child with its key, and asks the server for the one equality', async () => {
    const children = [
      { key: 'x', val: () => ({ n: 1 }) },
      { key: 'y', val: () => null },
    ];
    rtdb.get.mockResolvedValueOnce({
      forEach: (visit: (child: (typeof children)[number]) => void) => {
        for (const child of children) visit(child);
      },
    });
    const rows = await firebaseRealtimeTransport(database).getChildren('g', { order: { child: 'level' }, equalTo: 'gold' });
    expect(rows).toEqual([
      { key: 'x', value: { n: 1 } },
      { key: 'y', value: undefined },
    ]);
    expect(rtdb.orderByChild).toHaveBeenCalledWith('level');
    expect(rtdb.equalTo).toHaveBeenCalledWith('gold');
  });

  it('a dotted child is a slash path to Realtime Database, for a read and for a listener', async () => {
    rtdb.get.mockResolvedValueOnce({ forEach: () => {} });
    const transport = firebaseRealtimeTransport(database);
    await transport.getChildren('g', { order: { child: 'specs.level' }, equalTo: 'gold' });
    transport.onChildren('g', { order: { child: 'specs.level' }, equalTo: 'gold' }, { added: vi.fn() }, vi.fn());
    expect(rtdb.orderByChild.mock.calls).toEqual([['specs/level'], ['specs/level']]);
  });

  it('getChildren without a filter reads the plain ref', async () => {
    rtdb.get.mockResolvedValueOnce({ forEach: () => {} });
    await firebaseRealtimeTransport(database).getChildren('g', undefined);
    expect(rtdb.query).not.toHaveBeenCalled();
    expect(rtdb.get).toHaveBeenCalledWith({ kind: 'ref', path: 'g' });
  });
});

describe('Firestore adapter: one-time reads', () => {
  it('getDocument maps a missing document to undefined', async () => {
    fs.getDoc.mockResolvedValueOnce({ exists: () => false, data: () => undefined }).mockResolvedValueOnce({ exists: () => true, data: () => ({ name: 'Ann' }) });
    const transport = firebaseFirestoreTransport(firestore);
    expect(await transport.getDocument('users/1')).toBeUndefined();
    expect(await transport.getDocument('users/1')).toEqual({ name: 'Ann' });
    expect(fs.doc).toHaveBeenCalledWith(firestore, 'users/1');
  });

  it('getCollection sends the filters, then the order, then the limit, and maps documents to rows', async () => {
    fs.getDocs.mockResolvedValueOnce({ docs: [{ id: 'a', data: () => ({ name: 'Ann' }) }] });
    const rows = await firebaseFirestoreTransport(firestore).getCollection('users', {
      where: [{ field: 'tier', op: 'in', value: ['gold', 'silver'] }],
      orderBy: [{ field: 'age', direction: 'desc' }],
      limit: 5,
    });
    expect(rows).toEqual([{ id: 'a', data: { name: 'Ann' } }]);
    const [source] = fs.getDocs.mock.calls[0] as unknown as [{ constraints: unknown[] }];
    expect(source.constraints).toEqual([{ and: [{ where: ['tier', 'in', ['gold', 'silver']] }] }, { orderBy: ['age', 'desc'] }, { limit: 5 }]);
  });

  it('getCollection without order or limit sends only the filters', async () => {
    fs.getDocs.mockResolvedValueOnce({ docs: [] });
    await firebaseFirestoreTransport(firestore).getCollection('users', { where: [], orderBy: [] });
    const [source] = fs.getDocs.mock.calls[0] as unknown as [{ constraints: unknown[] }];
    expect(source.constraints).toEqual([]);
  });

  it('onCollection also sends order and limit for a live list', () => {
    firebaseFirestoreTransport(firestore).onCollection('users', { where: [], orderBy: [{ field: 'age', direction: 'asc' }], limit: 3 }, vi.fn(), vi.fn());
    const [source] = fs.onSnapshot.mock.calls[0] as unknown as [{ constraints: unknown[] }];
    expect(source.constraints).toEqual([{ orderBy: ['age', 'asc'] }, { limit: 3 }]);
  });
});

describe('Firestore adapter: the query features', () => {
  const constraintsOf = (mock: { mock: { calls: unknown[][] } }, call = 0) => (mock.mock.calls[call]![0] as { constraints: unknown[] }).constraints;

  it('an or of and-groups is one or(), a lone condition in a group is not wrapped', async () => {
    fs.getDocs.mockResolvedValueOnce({ docs: [] });
    await firebaseFirestoreTransport(firestore).getCollection('u', {
      where: [
        { field: 'tier', op: '==', value: 'gold' },
        {
          any: [
            [{ field: 'age', op: '>=', value: 30 }, { field: 'city', op: '==', value: 'Nice' }],
            [{ field: 'vip', op: '==', value: true }],
          ],
        },
      ],
      orderBy: [],
    });
    expect(constraintsOf(fs.getDocs)).toEqual([
      {
        and: [
          { where: ['tier', '==', 'gold'] },
          { or: [{ and: [{ where: ['age', '>=', 30] }, { where: ['city', '==', 'Nice'] }] }, { where: ['vip', '==', true] }] },
        ],
      },
    ]);
  });

  it('array-contains-any goes through as an ordinary filter', async () => {
    fs.getDocs.mockResolvedValueOnce({ docs: [] });
    await firebaseFirestoreTransport(firestore).getCollection('u', { where: [{ field: 'tags', op: 'array-contains-any', value: ['a', 'b'] }], orderBy: [] });
    expect(constraintsOf(fs.getDocs)).toEqual([{ and: [{ where: ['tags', 'array-contains-any', ['a', 'b']] }] }]);
  });

  it('the document id field becomes documentId(), in a filter and in an order', async () => {
    fs.getDocs.mockResolvedValueOnce({ docs: [] });
    await firebaseFirestoreTransport(firestore).getCollection('u', {
      where: [{ field: '__name__', op: 'in', value: ['a', 'b'] }],
      orderBy: [{ field: '__name__', direction: 'desc' }],
    });
    expect(fs.documentId).toHaveBeenCalledTimes(2);
    expect(constraintsOf(fs.getDocs)).toEqual([
      { and: [{ where: [{ documentId: true }, 'in', ['a', 'b']] }] },
      { orderBy: [{ documentId: true }, 'desc'] },
    ]);
  });

  it('cursors are startAt / startAfter / endAt / endBefore with the values, after the order and before the limit', async () => {
    fs.getDocs.mockResolvedValueOnce({ docs: [] }).mockResolvedValueOnce({ docs: [] });
    const transport = firebaseFirestoreTransport(firestore);
    const order = [{ field: 'age', direction: 'asc' as const }, { field: 'name', direction: 'asc' as const }];
    await transport.getCollection('u', { where: [], orderBy: order, start: { values: [30, 'N05'], inclusive: false }, end: { values: [40], inclusive: true }, limit: 7 });
    expect(constraintsOf(fs.getDocs, 0)).toEqual([{ orderBy: ['age', 'asc'] }, { orderBy: ['name', 'asc'] }, { startAfter: [30, 'N05'] }, { endAt: [40] }, { limit: 7 }]);
    await transport.getCollection('u', { where: [], orderBy: order, start: { values: [30], inclusive: true }, end: { values: [40], inclusive: false } });
    expect(constraintsOf(fs.getDocs, 1)).toEqual([{ orderBy: ['age', 'asc'] }, { orderBy: ['name', 'asc'] }, { startAt: [30] }, { endBefore: [40] }]);
  });

  it('a collection group query uses collectionGroup, for a read and for a live list', async () => {
    fs.getDocs.mockResolvedValueOnce({ docs: [] });
    const transport = firebaseFirestoreTransport(firestore);
    await transport.getCollection('lines', { where: [], orderBy: [], group: true });
    transport.onCollection('lines', { where: [], orderBy: [], group: true }, vi.fn(), vi.fn());
    expect(fs.collectionGroup).toHaveBeenCalledTimes(2);
    expect(fs.collectionGroup).toHaveBeenCalledWith(firestore, 'lines');
    expect(fs.collection).not.toHaveBeenCalled();
  });

  it('a read from the server or the cache uses the matching SDK call, for a document and for a list', async () => {
    fs.getDocFromServer.mockResolvedValueOnce({ exists: () => true, data: () => ({ a: 1 }) });
    fs.getDocFromCache.mockResolvedValueOnce({ exists: () => false, data: () => undefined });
    fs.getDocsFromServer.mockResolvedValueOnce({ docs: [] });
    fs.getDocsFromCache.mockResolvedValueOnce({ docs: [] });
    const transport = firebaseFirestoreTransport(firestore);
    expect(await transport.getDocument('u/1', { source: 'server' })).toEqual({ a: 1 });
    expect(await transport.getDocument('u/1', { source: 'cache' })).toBeUndefined();
    await transport.getCollection('u', { where: [], orderBy: [] }, { source: 'server' });
    await transport.getCollection('u', { where: [], orderBy: [] }, { source: 'cache' });
    expect([fs.getDocFromServer, fs.getDocFromCache, fs.getDocsFromServer, fs.getDocsFromCache].map(mock => mock.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(fs.getDoc).not.toHaveBeenCalled();
    expect(fs.getDocs).not.toHaveBeenCalled();
  });

  it('count, sum and average are one getAggregateFromServer over the same query', async () => {
    fs.getAggregateFromServer.mockResolvedValueOnce({ data: () => ({ n: 3, total: 90, mean: null }) });
    const result = await firebaseFirestoreTransport(firestore).getAggregate!(
      'u',
      { where: [{ field: 'tier', op: '==', value: 'gold' }], orderBy: [] },
      { n: { op: 'count' }, total: { op: 'sum', field: 'age' }, mean: { op: 'avg', field: 'age' } },
    );
    expect(result).toEqual({ n: 3, total: 90, mean: null });
    const [source, spec] = fs.getAggregateFromServer.mock.calls[0] as unknown as [{ constraints: unknown[] }, Record<string, unknown>];
    expect(source.constraints).toEqual([{ and: [{ where: ['tier', '==', 'gold'] }] }]);
    expect(spec).toEqual({ n: { agg: 'count' }, total: { agg: 'sum', field: 'age' }, mean: { agg: 'avg', field: 'age' } });
  });
});

describe('Realtime Database adapter: the query constraints', () => {
  const targetOf = (call = 0) => rtdb.get.mock.calls[call]![0] as { kind: string; constraints?: unknown[] };

  it('a key equality is orderByKey + equalTo', async () => {
    rtdb.get.mockResolvedValueOnce({ forEach: () => {} });
    await firebaseRealtimeTransport(database).getChildren('g', { order: { key: true }, equalTo: 'k1' });
    expect(targetOf().constraints).toEqual([{ orderByKey: true }, { equalTo: 'k1' }]);
  });

  it('a range is startAt / startAfter and endAt / endBefore on the order', async () => {
    rtdb.get.mockResolvedValueOnce({ forEach: () => {} }).mockResolvedValueOnce({ forEach: () => {} });
    const transport = firebaseRealtimeTransport(database);
    await transport.getChildren('g', { order: { child: 'score' }, start: { value: 3, inclusive: false }, end: { value: 9, inclusive: true } });
    expect(targetOf(0).constraints).toEqual([{ orderByChild: 'score' }, { startAfter: 3 }, { endAt: 9 }]);
    await transport.getChildren('g', { order: { child: 'score' }, start: { value: 3, inclusive: true }, end: { value: 9, inclusive: false } });
    expect(targetOf(1).constraints).toEqual([{ orderByChild: 'score' }, { startAt: 3 }, { endBefore: 9 }]);
  });

  it('a limit is limitToFirst or limitToLast, after the order, and can stand alone', async () => {
    rtdb.get.mockResolvedValue({ forEach: () => {} });
    const transport = firebaseRealtimeTransport(database);
    await transport.getChildren('g', { order: { child: 'score' }, limit: { first: 5 } });
    await transport.getChildren('g', { order: { child: 'score' }, limit: { last: 4 } });
    await transport.getChildren('g', { limit: { first: 7 } });
    expect([0, 1, 2].map(call => targetOf(call).constraints)).toEqual([
      [{ orderByChild: 'score' }, { limitToFirst: 5 }],
      [{ orderByChild: 'score' }, { limitToLast: 4 }],
      [{ limitToFirst: 7 }],
    ]);
    rtdb.get.mockReset();
  });

  it('an empty query is the plain ref', async () => {
    rtdb.get.mockResolvedValueOnce({ forEach: () => {} });
    await firebaseRealtimeTransport(database).getChildren('g', {});
    expect(rtdb.query).not.toHaveBeenCalled();
    expect(targetOf().kind).toBe('ref');
  });

  it('a live list is followed with the same query', () => {
    firebaseRealtimeTransport(database).onChildren('g', { order: { child: 'score' }, limit: { first: 3 } }, { added: vi.fn(), removed: vi.fn() }, vi.fn());
    const [source] = rtdb.onChildAdded.mock.calls[0] as unknown as [{ constraints: unknown[] }];
    expect(source.constraints).toEqual([{ orderByChild: 'score' }, { limitToFirst: 3 }]);
  });
});
