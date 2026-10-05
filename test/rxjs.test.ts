import { firstValueFrom, lastValueFrom, take, toArray } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ListenError, leaf, realtimeBackend, schema } from '../src';
import { observe } from '../src/rxjs';
import { MemoryRealtimeTransport } from '../src/testing';
import { definition, flush } from './fixtures';

const seed = () => ({
  summaries: { store: { store1: { productIds: ['p1', 'p2'] } } },
  customers: {
    '1': { name: 'Ann', tier: 'gold' },
    '2': { name: 'Bob', tier: 'silver' },
  },
});

let transport: MemoryRealtimeTransport;
let db: ReturnType<typeof make>;
const make = (t: MemoryRealtimeTransport) => schema(definition, realtimeBackend(t));
beforeEach(() => {
  transport = new MemoryRealtimeTransport(seed());
  db = make(transport);
});

describe('observe', () => {
  it('connects on subscribe, not before', () => {
    const ids$ = observe(db.summaries.store('store1').productIds);
    expect(transport.listenerCount).toBe(0);
    const subscription = ids$.subscribe();
    expect(transport.listenerCount).toBe(1);
    subscription.unsubscribe();
  });

  it('emits the value now and each change, and unsubscribing detaches', () => {
    const seen: unknown[] = [];
    const subscription = observe(db.summaries.store('store1').productIds).subscribe(ids => seen.push(ids));
    transport.set('summaries/store/store1/productIds', ['p1']);
    expect(seen).toEqual([['p1', 'p2'], ['p1']]);
    subscription.unsubscribe();
    expect(transport.listenerCount).toBe(0);
    transport.set('summaries/store/store1/productIds', ['p9']);
    expect(seen).toHaveLength(2);
  });

  it('take(1) and firstValueFrom close the connection by themselves', async () => {
    expect(await firstValueFrom(observe(db.summaries.store('store1').productIds))).toEqual(['p1', 'p2']);
    expect(transport.listenerCount).toBe(0);
    await lastValueFrom(observe(db.summaries.store('store1').productIds).pipe(take(1)));
    expect(transport.listenerCount).toBe(0);
  });

  it('subscribers share one connection without shareReplay, and the last one detaches it', async () => {
    const ids$ = observe(db.summaries.store('store1').productIds);
    const a = ids$.subscribe();
    const b = observe(db.summaries.store('store1').productIds).subscribe();
    expect(transport.listenerCount).toBe(1);
    a.unsubscribe();
    expect(transport.listenerCount).toBe(1);
    b.unsubscribe();
    expect(transport.listenerCount).toBe(0);
    await flush();
  });

  it('a second subscriber to an open connection still gets the current value', async () => {
    const first: unknown[] = [];
    const second: unknown[] = [];
    observe(db.summaries.store('store1').productIds).subscribe(v => first.push(v));
    observe(db.summaries.store('store1').productIds).subscribe(v => second.push(v));
    await flush();
    expect(second).toEqual([['p1', 'p2']]);
    expect(transport.listenerCount).toBe(1);
  });

  it('a denied listen becomes an Observable error that names the caller', async () => {
    transport.deny('summaries');
    const error = (await firstValueFrom(observe(db.summaries.store('store1').productIds, 'connectToStoreProductIds')).catch(e => e)) as ListenError;
    expect(error).toBeInstanceOf(ListenError);
    expect(error.identifier).toBe('connectToStoreProductIds');
    expect(error.message).toMatch(/^PERMISSION_DENIED: Permission denied \(listen --- connectToStoreProductIds\)/);
    expect(transport.listenerCount).toBe(0);
  });

  it('resubscribing after an error connects again', async () => {
    transport.deny('summaries');
    const ids$ = observe(db.summaries.store('store1').productIds, 'x');
    await firstValueFrom(ids$).catch(() => undefined);
    const second = await firstValueFrom(ids$).catch(e => e);
    expect(second).toBeInstanceOf(ListenError);
  });

  it('observes a keyed list and a selected node', async () => {
    const rows = await lastValueFrom(observe(db.customers.where('tier', '==', 'gold').select('name')).pipe(take(1), toArray()));
    expect(rows).toEqual([{ key: '1', attribute: 'name', value: 'Ann' }]);
    const changes: unknown[] = [];
    const subscription = observe(db.customers('2').select('name', 'tier')).subscribe(change => changes.push(change));
    transport.set('customers/2/tier', 'gold');
    expect(changes).toEqual([
      { attribute: 'name', value: 'Bob' },
      { attribute: 'tier', value: 'silver' },
      { attribute: 'tier', value: 'gold' },
    ]);
    subscription.unsubscribe();
    expect(transport.listenerCount).toBe(0);
  });

  it('observes a decoded leaf', async () => {
    const decoded = schema({ n: leaf<string[]>().decode(ids => new Set(ids)) }, realtimeBackend(new MemoryRealtimeTransport({ n: ['a', 'a', 'b'] })));
    expect(await firstValueFrom(observe(decoded.n))).toEqual(new Set(['a', 'b']));
  });
});
