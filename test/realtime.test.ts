import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ListenError, UnsupportedQueryError, realtimeBackend, schema } from '../src';
import { MemoryRealtimeTransport } from '../src/testing';
import { definition, flush } from './fixtures';

const seed = () => ({
  summaries: {
    store: {
      store1: { productIds: ['p1', 'p2'], featuredIds: ['p1_f', 'p2_f'] },
    },
  },
  customers: {
    '1': { name: 'Ann', age: 12, tier: 'gold', contact: { email: 'ann@example.test', phone: '555-0101' } },
    '2': { name: 'Bob', age: 14, tier: 'silver', contact: { email: 'bob@example.test', phone: '555-0102' } },
    '3': { name: 'Cy', age: 13, tier: 'gold', contact: { email: 'cy@example.test', phone: '555-0103' } },
  },
});

let transport: MemoryRealtimeTransport;
let db: ReturnType<typeof makeDb>;
const makeDb = (t: MemoryRealtimeTransport) => schema(definition, realtimeBackend(t));

beforeEach(() => {
  transport = new MemoryRealtimeTransport(seed());
  db = makeDb(transport);
});

describe('listening to a leaf', () => {
  it('delivers the value now and again when it changes', () => {
    const seen: unknown[] = [];
    db.summaries.store('store1').productIds.listen(ids => seen.push(ids));
    expect(seen).toEqual([['p1', 'p2']]);
    transport.set('summaries/store/store1/productIds', ['p1', 'p2', 'p3']);
    expect(seen).toEqual([['p1', 'p2'], ['p1', 'p2', 'p3']]);
  });

  it('is quiet while a sibling leaf changes', () => {
    const seen: unknown[] = [];
    db.summaries.store('store1').productIds.listen(ids => seen.push(ids));
    transport.set('summaries/store/store1/featuredIds', ['x']);
    expect(seen).toHaveLength(1);
  });

  it('a node that does not exist arrives as undefined', () => {
    const seen: unknown[] = [];
    db.summaries.store('nobody').productIds.listen(ids => seen.push(ids));
    expect(seen).toEqual([undefined]);
  });

  it('the path is built from the property names and the ids', () => {
    const paths: string[] = [];
    const spy = new Proxy(transport, {
      get(target, property, receiver) {
        if (property === 'onValue') {
          return (path: string, ...rest: any[]) => (paths.push(path), (target.onValue as any)(path, ...rest));
        }
        return Reflect.get(target, property, receiver);
      },
    });
    schema(definition, realtimeBackend(spy)).summaries.store('store1').featuredIds.listen(() => {});
    expect(paths).toEqual(['summaries/store/store1/featuredIds']);
  });

  it('rejects an id that would change the path', () => {
    expect(() => db.summaries.store('')).toThrow(/Invalid path segment/);
    expect(() => db.summaries.store('a/b')).toThrow(/Invalid path segment/);
    expect(() => db.customers('')).toThrow(/Invalid path segment/);
  });

  it('accepts a numeric id', () => {
    const seen: unknown[] = [];
    (db.customers as any)(1).select('name').listen((change: unknown) => seen.push(change));
    expect(seen).toEqual([{ attribute: 'name', value: 'Ann' }]);
  });

  it('a stopped listener hears nothing more and stop() is safe to repeat', () => {
    const seen: unknown[] = [];
    const stop = db.summaries.store('store1').productIds.listen(ids => seen.push(ids));
    stop();
    stop();
    transport.set('summaries/store/store1/productIds', ['z']);
    expect(seen).toHaveLength(1);
    expect(transport.listenerCount).toBe(0);
  });

  it('a callback may stop itself', () => {
    const seen: unknown[] = [];
    const holder: { stop?: () => void } = {};
    holder.stop = db.summaries.store('store1').productIds.listen(ids => {
      seen.push(ids);
      holder.stop?.();
    });
    holder.stop();
    transport.set('summaries/store/store1/productIds', ['z']);
    expect(seen).toHaveLength(1);
    expect(transport.listenerCount).toBe(0);
  });

  it('subscribe is the same lifecycle with an error channel', () => {
    const seen: unknown[] = [];
    const stop = db.summaries.store('store1').productIds.subscribe(ids => seen.push(ids));
    expect(transport.listenerCount).toBe(1);
    stop();
    expect(transport.listenerCount).toBe(0);
    expect(seen).toHaveLength(1);
  });
});

describe('select listens per attribute', () => {
  it('one listener per selected attribute, and the callback says which one changed', () => {
    const changes: unknown[] = [];
    db.customers('1')
      .select('name', 'age', 'contact.*')
      .listen(change => changes.push(change));
    expect(transport.listenerCount).toBe(3); // name, age, and the children of contact
    expect(changes).toEqual([
      { attribute: 'name', value: 'Ann' },
      { attribute: 'age', value: 12 },
      { attribute: 'contact.email', value: 'ann@example.test' },
      { attribute: 'contact.phone', value: '555-0101' },
    ]);

    changes.length = 0;
    transport.set('customers/1/tier', 'silver'); // not selected
    expect(changes).toEqual([]);

    transport.set('customers/1/name', 'Anna');
    expect(changes).toEqual([{ attribute: 'name', value: 'Anna' }]);

    changes.length = 0;
    transport.set('customers/1/contact/email', 'ann.new@example.test');
    expect(changes).toEqual([{ attribute: 'contact.email', value: 'ann.new@example.test' }]);
  });

  it('a new field under contact.* arrives, and a deleted one arrives as undefined', () => {
    const changes: any[] = [];
    db.customers('1')
      .select('contact.*')
      .listen(change => changes.push(change));
    changes.length = 0;
    transport.set('customers/1/contact/fax', '555-0199');
    transport.set('customers/1/contact/phone', null);
    expect(changes).toEqual([
      { attribute: 'contact.fax', value: '555-0199' },
      { attribute: 'contact.phone', value: undefined },
    ]);
  });

  it("select('*') is the whole node and today's valueChange$", () => {
    const seen: unknown[] = [];
    db.customers('2')
      .select('*')
      .listen(customer => seen.push(customer));
    expect(seen).toEqual([seed().customers['2']]);
    transport.set('customers/2/age', 15);
    expect(seen).toHaveLength(2);
  });

  it('without select the callback gets the whole value', () => {
    const seen: unknown[] = [];
    db.customers('2').listen(customer => seen.push(customer));
    expect(seen).toEqual([seed().customers['2']]);
  });

  it('a selected attribute that is absent arrives once as undefined', () => {
    const changes: unknown[] = [];
    db.customers('1')
      .select('name')
      .listen(change => changes.push(change));
    transport.set('customers/1/name', null);
    expect(changes).toEqual([
      { attribute: 'name', value: 'Ann' },
      { attribute: 'name', value: undefined },
    ]);
  });

  it('refuses an empty select and "*" mixed with names', () => {
    expect(() => (db.customers('1') as any).select()).toThrow(/at least one attribute/);
    expect(() => (db.customers('1') as any).select('*', 'name')).toThrow(/cannot be combined/);
  });
});

describe('a filtered list', () => {
  const rows = () => {
    const changes: any[] = [];
    const stop = db.customers
      .where('tier', '==', 'gold')
      .select('name', 'age')
      .listen(change => changes.push(change), 'connectToCustomers');
    return { changes, stop };
  };

  it('tracks which children exist with one equality, then listens to the selected attributes of each', () => {
    const { changes } = rows();
    expect(changes).toEqual([
      { key: '1', attribute: 'name', value: 'Ann' },
      { key: '1', attribute: 'age', value: 12 },
      { key: '3', attribute: 'name', value: 'Cy' },
      { key: '3', attribute: 'age', value: 13 },
    ]);
    // 1 membership listener + 2 attributes for each of the 2 rows
    expect(transport.listenerCount).toBe(1 + 4);
  });

  it('is quiet when a row changes an attribute that is not selected, or a row outside the filter changes', () => {
    const { changes } = rows();
    changes.length = 0;
    transport.set('customers/1/contact/email', 'other');
    transport.set('customers/2/name', 'Robert');
    expect(changes).toEqual([]);
  });

  it('reports a selected attribute of one row', () => {
    const { changes } = rows();
    changes.length = 0;
    transport.set('customers/3/age', 14);
    expect(changes).toEqual([{ key: '3', attribute: 'age', value: 14 }]);
  });

  it('a row that starts to match arrives, and a row that stops matching is removed and its listeners detach', () => {
    const { changes } = rows();
    changes.length = 0;

    transport.set('customers/2/tier', 'gold');
    expect(changes).toEqual([
      { key: '2', attribute: 'name', value: 'Bob' },
      { key: '2', attribute: 'age', value: 14 },
    ]);
    expect(transport.listenerCount).toBe(1 + 6);

    changes.length = 0;
    transport.set('customers/1/tier', 'silver');
    expect(changes).toEqual([{ key: '1', attribute: '*', value: undefined, removed: true }]);
    expect(transport.listenerCount).toBe(1 + 4);

    changes.length = 0;
    transport.set('customers/1/name', 'Ghost');
    expect(changes).toEqual([]);
  });

  it('stopping detaches the membership listener and every row listener', () => {
    const { stop } = rows();
    stop();
    expect(transport.listenerCount).toBe(0);
  });

  it('a list without a filter tracks every child', () => {
    const changes: any[] = [];
    db.customers.select('name').listen(change => changes.push(change));
    expect(changes.map(change => change.key)).toEqual(['1', '2', '3']);
  });

  it('without select the rows arrive whole', () => {
    const changes: any[] = [];
    db.customers.where('tier', '==', 'silver').listen(change => changes.push(change));
    expect(changes).toEqual([{ key: '2', attribute: '*', value: seed().customers['2'] }]);
  });
});

describe('what Realtime Database cannot filter is refused before anything connects', () => {
  const refuse = (start: () => void, message: RegExp) => {
    expect(start).toThrow(UnsupportedQueryError);
    expect(start).toThrow(message);
    expect(transport.listenerCount).toBe(0);
  };

  it('a second equality', () => {
    refuse(() => db.customers.where('tier', '==', 'a').where('age', '==', 1).listen(() => {}), /Realtime Database cannot run "age == 1"/);
  });
  it('a range', () => {
    refuse(() => db.customers.where('age', '>', 12).listen(() => {}), /cannot run "age > 12"/);
  });
  it('a predicate', () => {
    refuse(() => db.customers.where(customer => customer.age > 1).listen(() => {}), /cannot run "a where\(item => boolean\) check"/);
  });
  it('whereIncludes', () => {
    refuse(() => db.customers.whereIncludes('tags', 'x').listen(() => {}), /cannot run "tags includes "x""/);
  });
  it('an equality on a value that is not a scalar', () => {
    refuse(() => db.customers.where('name', '==', undefined as unknown as string).listen(() => {}), /cannot run/);
  });
  it('says what to do instead', () => {
    expect(() => db.customers.where('age', '>', 12).listen(() => {})).toThrow(/\.from\(rows\)/);
  });
});

describe('the same description runs on rows you hold', () => {
  it('from(rows) needs no backend', () => {
    const offline = schema(definition);
    const rows = Object.values(seed().customers) as any[];
    expect(offline.customers.where('tier', '==', 'gold').select('name', 'age').from(rows)).toEqual([
      { name: 'Ann', age: 12 },
      { name: 'Cy', age: 13 },
    ]);
  });

  it('listen without a backend says so', () => {
    expect(() => schema(definition).summaries.store('o').productIds.listen(() => {})).toThrow(/no backend/);
    expect(() => schema(definition).customers.select('name').listen(() => {})).toThrow(/no backend/);
  });

  it('a list method on a function that returns segments explains itself', () => {
    expect(() => (db.summaries.store as any).where('productIds', '==', [])).toThrow(/not a list of leaves/);
  });

  it('when() adds a clause to a list query only when present', () => {
    const rows = Object.values(seed().customers) as any[];
    const run = (tier?: string) =>
      db.customers.when(tier, (query, present) => query.where('tier', '==', present)).select('name').from(rows);
    expect(run()).toEqual(['Ann', 'Bob', 'Cy']);
    expect(run('silver')).toEqual(['Bob']);
  });
});

describe('one connection, and it stops', () => {
  const ids = () => db.summaries.store('store1').productIds;

  it('two callers on the same path share one Realtime Database listener; the last stop detaches it', () => {
    const stopA = ids().listen(() => {});
    const stopB = ids().listen(() => {});
    expect(transport.listenerCount).toBe(1);
    stopA();
    expect(transport.listenerCount).toBe(1); // screen B is still listening
    stopB();
    expect(transport.listenerCount).toBe(0); // last subscriber
  });

  it('every caller hears every change, and a stopped caller stops hearing', async () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const stopA = ids().listen(value => a.push(value));
    ids().listen(value => b.push(value));
    await flush(); // the second caller joins an open connection and is replayed the current value
    transport.set('summaries/store/store1/productIds', ['n1']);
    stopA();
    transport.set('summaries/store/store1/productIds', ['n2']);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(3);
  });

  it('a late joiner gets the current value, not a stale one, without a second connection', async () => {
    const early: unknown[] = [];
    ids().listen(value => early.push(value));
    transport.set('summaries/store/store1/productIds', ['fresh']);
    const late: unknown[] = [];
    ids().listen(value => late.push(value));
    expect(late).toEqual([]); // replayed on a microtask, so `stop` exists before the callback runs
    await flush();
    expect(late).toEqual([['fresh']]);
    expect(transport.listenerCount).toBe(1);
  });

  it('a late joiner never sees an older value after a newer one: what arrives before its replay is folded into it', async () => {
    ids().listen(() => {});
    const late: unknown[] = [];
    ids().listen(value => late.push(value));
    transport.set('summaries/store/store1/productIds', ['during-replay-window']);
    await flush();
    expect(late).toEqual([['during-replay-window']]);
    transport.set('summaries/store/store1/productIds', ['after']);
    expect(late).toEqual([['during-replay-window'], ['after']]);
  });

  it('a caller that stops before its replay never hears it', async () => {
    ids().listen(() => {});
    const late: unknown[] = [];
    ids().listen(value => late.push(value))();
    await flush();
    expect(late).toEqual([]);
  });

  it('a late joiner on a list is replayed every row, and not a row that was removed', async () => {
    const list = () => db.customers.where('tier', '==', 'gold').select('name');
    list().listen(() => {});
    transport.set('customers/1/tier', 'silver');
    const late: any[] = [];
    list().listen(change => late.push(change));
    await flush();
    expect(late).toEqual([{ key: '3', attribute: 'name', value: 'Cy' }]);
    expect(transport.listenerCount).toBe(2);
  });

  it('the same select in a different order shares; a different select does not', () => {
    const one = () => db.customers('1');
    one().select('name', 'age').listen(() => {});
    one().select('age', 'name').listen(() => {});
    const before = transport.listenerCount;
    expect(before).toBe(2);
    one().select('name').listen(() => {});
    expect(transport.listenerCount).toBe(before + 1);
  });

  it('a different path does not share', () => {
    db.customers('1').select('name').listen(() => {});
    db.customers('2').select('name').listen(() => {});
    expect(transport.listenerCount).toBe(2);
  });

  it('a new caller after the last stop opens a fresh connection', () => {
    ids().listen(() => {})();
    expect(transport.listenerCount).toBe(0);
    const seen: unknown[] = [];
    ids().listen(value => seen.push(value));
    expect(transport.listenerCount).toBe(1);
    expect(seen).toEqual([['p1', 'p2']]);
  });

  it('two schemas over two backends never share', () => {
    const other = makeDb(transport);
    ids().listen(() => {});
    other.summaries.store('store1').productIds.listen(() => {});
    expect(transport.listenerCount).toBe(2);
  });
});

describe('permission errors stay named', () => {
  beforeEach(() => {
    transport.deny('summaries/store');
  });

  it('a denied listen names the caller and the path', () => {
    const onError = vi.fn();
    db.summaries.store('store1').productIds.listen(() => {}, 'connectToStoreProductIds', onError);
    expect(onError).toHaveBeenCalledOnce();
    const error = onError.mock.calls[0]![0] as ListenError;
    expect(error).toBeInstanceOf(ListenError);
    expect(error.code).toBe('PERMISSION_DENIED');
    expect(error.identifier).toBe('connectToStoreProductIds');
    expect(error.path).toBe('summaries/store/store1/productIds');
    expect(error.message).toMatch(
      /^PERMISSION_DENIED: Permission denied \(listen --- connectToStoreProductIds\): permission_denied at .+ --- summaries\/store\/store1\/productIds$/,
    );
    expect((error.cause as { code: string }).code).toBe('PERMISSION_DENIED');
  });

  it('a shared connection does not erase which caller received the error', () => {
    const errorsA = vi.fn();
    const errorsB = vi.fn();
    // Open first, then deny: the connection is shared when the denial arrives.
    const open = new MemoryRealtimeTransport(seed());
    const shared = schema(definition, realtimeBackend(open));
    shared.summaries.store('store1').productIds.listen(() => {}, 'screenA', errorsA);
    shared.summaries.store('store1').productIds.listen(() => {}, 'screenB', errorsB);
    expect(open.listenerCount).toBe(1);
    open.deny('summaries/store');
    expect((errorsA.mock.calls[0]![0] as ListenError).identifier).toBe('screenA');
    expect((errorsB.mock.calls[0]![0] as ListenError).identifier).toBe('screenB');
    expect(errorsA.mock.calls[0]![0].message).toContain('(listen --- screenA)');
    expect(errorsB.mock.calls[0]![0].message).toContain('(listen --- screenB)');
    expect(open.listenerCount).toBe(0);
  });

  it('a caller with no identifier still gets a named error', () => {
    const onError = vi.fn();
    db.summaries.store('store1').productIds.listen(() => {}, undefined, onError);
    expect(onError.mock.calls[0]![0].message).toMatch(/^PERMISSION_DENIED: Permission denied \(listen\): /);
  });

  it('a denied list or attribute select is named too', () => {
    transport.deny('customers');
    const onError = vi.fn();
    db.customers.select('name').listen(() => {}, 'connectToCustomers', onError);
    expect(onError.mock.calls[0]![0].message).toMatch(/\(listen --- connectToCustomers\).* --- customers$/);
    expect(transport.listenerCount).toBe(0);
  });

  it('a failed connection is dropped, so a later caller starts clean and stop() stays safe', () => {
    const onError = vi.fn();
    const stop = db.summaries.store('store1').productIds.listen(() => {}, 'first', onError);
    stop();
    expect(() => stop()).not.toThrow();
    const again = vi.fn();
    db.summaries.store('store1').productIds.listen(() => {}, 'second', again);
    expect(again).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('without an error handler the error is reported, not swallowed', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.summaries.store('store1').productIds.listen(() => {}, 'connectToStoreProductIds');
    expect(report).toHaveBeenCalledOnce();
    expect((report.mock.calls[0]![0] as Error).message).toContain('connectToStoreProductIds');
    report.mockRestore();
  });
});

describe('errors that are not permission errors', () => {
  it('pass through untouched', () => {
    const boom = new Error('network down');
    const failing = schema(definition, realtimeBackend({
      onValue: (_path, _next, error) => (error(boom), () => {}),
      onChildren: () => () => {},
      getValue: async () => undefined,
      getChildren: async () => [],
    }));
    const onError = vi.fn();
    failing.summaries.store('o').productIds.listen(() => {}, 'x', onError);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('a transport that throws while connecting is reported to the caller, and nothing stays open', () => {
    const stops = vi.fn();
    const failing = schema(definition, realtimeBackend({
      onValue: (path, next) => {
        if (path.endsWith('age')) throw new Error('cannot open');
        next(1);
        return stops;
      },
      onChildren: () => () => {},
      getValue: async () => undefined,
      getChildren: async () => [],
    }));
    const onError = vi.fn();
    failing.customers('1').select('name', 'age').listen(() => {}, 'x', onError);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0].message).toBe('cannot open');
    expect(stops).toHaveBeenCalledOnce(); // the listener that did open was closed
  });
});

describe('a callback that throws', () => {
  it('goes to that caller\'s error handler and does not break another caller or the connection', async () => {
    const errors = vi.fn();
    const good: unknown[] = [];
    let first = true;
    db.summaries.store('store1').productIds.listen(() => {
      if (first) {
        first = false;
        return;
      }
      throw new Error('handler bug');
    }, 'bad', errors);
    db.summaries.store('store1').productIds.listen(value => good.push(value), 'good');
    await flush();
    good.length = 0;
    transport.set('summaries/store/store1/productIds', ['n']);
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]![0].message).toBe('handler bug');
    expect(good).toEqual([['n']]);
    expect(transport.listenerCount).toBe(1);
  });
});
