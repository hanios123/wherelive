import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, remove, set, update } from 'firebase/database';
import { ListenError, leaf, realtimeBackend, schema, type Holder } from '../src';
import { firebaseRealtimeTransport } from '../src/firebase';
import type { RealtimeTransport } from '../src/transport';
import { clearDatabase, connectDatabase, eventually, settle, writeDatabase } from './env';
import { follow, stopAll } from './follow';

// Live nodes and lists on the real Firebase SDK, against the emulator.

interface Customer {
  name: string;
  age: number;
  tier: string;
  contact: { email: string; phone: string };
}
const definition = {
  summaries: {
    store: (storeId: string) => ({
      productIds: leaf<string[]>(),
      featuredIds: leaf<string[]>(),
      byId: leaf<Holder<{ id: string; price: number }>>(),
    }),
  },
  customers: (id: string) => leaf<Customer>(),
  locked: { secret: leaf<string>() },
};

// A new connection for every test, so nothing one test listened to is remembered by the next.
let connection: ReturnType<typeof connectDatabase>;
let transport: RealtimeTransport;
beforeEach(async () => {
  await clearDatabase();
  connection = connectDatabase();
  transport = firebaseRealtimeTransport(connection.database);
});
afterEach(async () => {
  stopAll();
  await connection.close();
});

const database = () => schema(definition, realtimeBackend(transport));
const at = (path: string) => ref(connection.database, path);

const ann = { name: 'Ann', age: 12, tier: 'gold', contact: { email: 'ann@example.test', phone: '555-0101' } };
const bob = { name: 'Bob', age: 14, tier: 'silver', contact: { email: 'bob@example.test', phone: '555-0102' } };
const cy = { name: 'Cy', age: 13, tier: 'gold', contact: { email: 'cy@example.test', phone: '555-0103' } };

describe('a node', () => {
  it('delivers the value now and again when it changes, and stays quiet while a sibling changes', async () => {
    await writeDatabase('summaries/store/s1/productIds', ['p1', 'p2']);
    const seen: unknown[] = [];
    stopLater(database().summaries.store('s1').productIds.listen(ids => seen.push(ids)));
    await eventually(() => expect(seen).toEqual([['p1', 'p2']]));

    await set(at('summaries/store/s1/featuredIds'), ['x']);
    await settle();
    expect(seen).toHaveLength(1);

    await set(at('summaries/store/s1/productIds'), ['p1', 'p2', 'p3']);
    await eventually(() => expect(seen).toEqual([['p1', 'p2'], ['p1', 'p2', 'p3']]));
  });

  it('a node that does not exist arrives as undefined, and so does one that is emptied', async () => {
    const seen: unknown[] = [];
    stopLater(database().summaries.store('nobody').productIds.listen(ids => seen.push(ids)));
    await eventually(() => expect(seen).toEqual([undefined]));
    await set(at('summaries/store/nobody/productIds'), ['a']);
    await eventually(() => expect(seen).toEqual([undefined, ['a']]));
    await set(at('summaries/store/nobody/productIds'), []); // Realtime Database keeps no empty array
    await eventually(() => expect(seen).toEqual([undefined, ['a'], undefined]));
  });

  it('one node read once', async () => {
    await writeDatabase('summaries/store/s1/productIds', ['p1', 'p2']);
    expect(await database().summaries.store('s1').productIds.get()).toEqual(['p1', 'p2']);
    expect(await database().summaries.store('s2').productIds.get()).toBeUndefined();
  });

  it('selected attributes: one listener each, so a sibling field stays quiet', async () => {
    await writeDatabase('customers/1', ann);
    const { events, stop } = follow(next => database().customers('1').select('name', 'age').listen(next));
    stopLater(stop);
    await eventually(() =>
      expect(events).toEqual([
        { attribute: 'name', value: 'Ann' },
        { attribute: 'age', value: 12 },
      ]),
    );
    events.length = 0;
    await update(at('customers/1'), { tier: 'silver' });
    await settle();
    expect(events).toEqual([]);
    await update(at('customers/1'), { age: 13 });
    await eventually(() => expect(events).toEqual([{ attribute: 'age', value: 13 }]));
  });

  it('contact.* reports the fields under contact, and only the one that changed', async () => {
    await writeDatabase('customers/1', ann);
    const { events, stop } = follow(next => database().customers('1').select('contact.*').listen(next));
    stopLater(stop);
    await eventually(() => expect(events.map(change => change.attribute).sort()).toEqual(['contact.email', 'contact.phone']));
    events.length = 0;
    await set(at('customers/1/contact/email'), 'ann.new@example.test');
    await eventually(() => expect(events).toEqual([{ attribute: 'contact.email', value: 'ann.new@example.test' }]));
  });
});

describe('a list', () => {
  it('delivers each row, then what is added, changed and removed', async () => {
    await writeDatabase('customers', { 1: ann, 2: bob });
    const { snapshot, events, stop } = follow(next => database().customers.select('name', 'age').listen(next));
    stopLater(stop);
    await eventually(() => expect(snapshot()).toEqual({ 1: { name: 'Ann', age: 12 }, 2: { name: 'Bob', age: 14 } }));

    await set(at('customers/3'), cy);
    await eventually(() => expect(snapshot()[3]).toEqual({ name: 'Cy', age: 13 }));

    events.length = 0;
    await set(at('customers/1/age'), 20);
    await eventually(() => expect(events).toEqual([{ key: '1', attribute: 'age', value: 20 }]));

    events.length = 0;
    await remove(at('customers/2'));
    await eventually(() => expect(events[events.length - 1]).toEqual({ key: '2', attribute: '*', value: undefined, removed: true }));
    // Each selected attribute says undefined first and the row is reported gone last, so a caller keeping rows ends with none.
    expect(events.slice(0, -1).every(change => change.key === '2' && change.value === undefined)).toBe(true);
    expect(Object.keys(snapshot()).sort()).toEqual(['1', '3']);
  });

  it('an equality on a child: a row leaves when it stops matching and arrives when it starts', async () => {
    await writeDatabase('customers', { 1: ann, 2: bob, 3: cy });
    const { snapshot, stop } = follow(next => database().customers.where('tier', '==', 'gold').select('name').listen(next));
    stopLater(stop);
    await eventually(() => expect(snapshot()).toEqual({ 1: { name: 'Ann' }, 3: { name: 'Cy' } }));
    await set(at('customers/1/tier'), 'silver');
    await set(at('customers/2/tier'), 'gold');
    await eventually(() => expect(snapshot()).toEqual({ 2: { name: 'Bob' }, 3: { name: 'Cy' } }));
  });

  it('a limit window follows the order as rows come and go', async () => {
    await writeDatabase('customers', { 1: ann, 2: bob, 3: cy });
    const { snapshot, stop } = follow(next => database().customers.orderBy('age').limit(2).select('name').listen(next));
    stopLater(stop);
    await eventually(() => expect(Object.keys(snapshot()).sort()).toEqual(['1', '3']));
    await set(at('customers/4'), { ...bob, name: 'Dee', age: 1 });
    await eventually(() => expect(Object.keys(snapshot()).sort()).toEqual(['1', '4']));
    await remove(at('customers/4'));
    await eventually(() => expect(Object.keys(snapshot()).sort()).toEqual(['1', '3']));
  });

  it('reads a filtered list once, in key order when no order is asked for', async () => {
    await writeDatabase('customers', { 1: ann, 2: bob, 3: cy, 10: { ...ann, name: 'Ten' } });
    const rows = await database().customers.where('tier', '==', 'gold').select('name').get();
    expect(rows).toEqual(['Ann', 'Cy', 'Ten']); // keys 1, 3, 10: Realtime Database sorts keys that are whole numbers as numbers
  });

  it('callers with the same query share one set of listeners, and the last to stop removes them', async () => {
    await writeDatabase('customers', { 1: ann, 2: bob });
    const tally = { opened: 0, open: 0 };
    const watch = <A extends unknown[]>(open: (...args: A) => () => void) => (...args: A) => {
      tally.opened++;
      tally.open++;
      const stop = open(...args);
      return () => {
        tally.open--;
        stop();
      };
    };
    const counting: RealtimeTransport = { ...transport, onValue: watch(transport.onValue.bind(transport)), onChildren: watch(transport.onChildren.bind(transport)) };
    const db = schema(definition, realtimeBackend(counting));
    const first = follow(next => db.customers.select('name').listen(next));
    const second = follow(next => db.customers.select('name').listen(next));
    await eventually(() => expect(second.snapshot()).toEqual({ 1: { name: 'Ann' }, 2: { name: 'Bob' } }));
    expect(tally.opened).toBe(1 + 2); // one for the children, one name listener for each of the two rows
    first.stop();
    expect(tally.open).toBe(3);
    second.stop();
    expect(tally.open).toBe(0);
  });
});

describe('a denied read is named after the caller', () => {
  it('a live node reports a ListenError with the caller and the path', async () => {
    const onError = vi.fn();
    stopLater(database().locked.secret.listen(() => {}, 'watchSecret', onError));
    await eventually(() => expect(onError).toHaveBeenCalled());
    const error = onError.mock.calls[0]?.[0] as ListenError;
    expect(error).toBeInstanceOf(ListenError);
    expect(error.code).toBe('PERMISSION_DENIED');
    expect(error.identifier).toBe('watchSecret');
    expect(error.path).toBe('locked/secret');
    expect(error.message).toMatch(/^PERMISSION_DENIED: Permission denied \(listen --- watchSecret\): .* --- locked\/secret$/);
  });

  it('a one-time read rejects the same way', async () => {
    const error = (await database().locked.secret.get('loadSecret').catch((caught: unknown) => caught)) as ListenError;
    expect(error).toBeInstanceOf(ListenError);
    expect(error.message).toMatch(/^PERMISSION_DENIED: Permission denied \(get --- loadSecret\): .* --- locked\/secret$/);
  });
});

function stopLater(stop: () => void): void {
  cleanups.push(stop);
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
});
