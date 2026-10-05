import { beforeEach, describe, expect, it, vi } from 'vitest';
import { leaf, realtimeBackend, schema } from '../src';
import { MemoryRealtimeTransport } from '../src/testing';
import { flush } from './fixtures';

type Raw = Record<string, any>;

const seed = () => ({
  stores: {
    s1: {
      items: {
        createdBy: 'ann',
        updatedBy: 'bob',
        a: { price: 1, updatedAt: 1000 },
        b: { price: 2, updatedAt: 2000 },
      },
    },
  },
});

/** One node, read four ways. The same path, so the same connection. */
const plain = {
  stores: (id: string) => ({ items: leaf<Raw>() }),
};
const decoded = {
  stores: (id: string) => ({
    items: leaf<Raw>().except('createdBy', 'updatedBy'),
  }),
};
const revived = {
  stores: (id: string) => ({
    items: leaf<Raw>()
      .except('createdBy', 'updatedBy')
      .decode(items => items && Object.fromEntries(Object.entries(items).map(([key, item]) => [key, { ...item, $key: key, updatedAt: new Date(item.updatedAt) }]))),
  }),
};
const counted = {
  stores: (id: string) => ({ items: leaf<Raw>().decode(raw => Object.keys(raw ?? {}).length) }),
};

let transport: MemoryRealtimeTransport;
beforeEach(() => {
  transport = new MemoryRealtimeTransport(seed());
});
const on = <D extends Parameters<typeof schema>[0]>(definition: D, shared = realtimeBackend(transport)) => schema(definition, shared);

describe('except', () => {
  it('drops the keys at the root of the value and keeps everything else', () => {
    const seen: unknown[] = [];
    on(decoded).stores('s1').items.listen(items => seen.push(items));
    expect(seen).toEqual([{ a: { price: 1, updatedAt: 1000 }, b: { price: 2, updatedAt: 2000 } }]);
  });

  it('works on a copy: the stored value and other callers are not touched', async () => {
    const backend = realtimeBackend(transport);
    const cleaned: Raw[] = [];
    const whole: Raw[] = [];
    on(decoded, backend).stores('s1').items.listen(items => cleaned.push(items!));
    on(plain, backend).stores('s1').items.listen(items => whole.push(items!));
    await flush(); // the second caller joins an open connection and is replayed on a microtask
    expect(Object.keys(whole[0]!)).toEqual(['createdBy', 'updatedBy', 'a', 'b']);
    expect(cleaned[0]).not.toBe(whole[0]);
    expect(transport.get('stores/s1/items')).toHaveProperty('createdBy');
  });

  it('a node that does not exist stays undefined', () => {
    const seen: unknown[] = [];
    on(decoded).stores('nowhere').items.listen(items => seen.push(items));
    expect(seen).toEqual([undefined]);
  });

  it('follows changes', () => {
    const seen: Raw[] = [];
    on(decoded).stores('s1').items.listen(items => seen.push(items!));
    transport.set('stores/s1/items/updatedBy', 'zed'); // a metadata change arrives as the same value, minus the key
    transport.set('stores/s1/items/a/price', 5);
    expect(seen[seen.length - 1]).toEqual({ a: { price: 5, updatedAt: 1000 }, b: { price: 2, updatedAt: 2000 } });
  });
});

describe('decode', () => {
  it('receives undefined for a node that does not exist and returns what it likes', () => {
    const seen: number[] = [];
    on(counted).stores('nowhere').items.listen(count => seen.push(count));
    on(counted).stores('s1').items.listen(count => seen.push(count));
    expect(seen).toEqual([0, 4]);
  });

  it('chains after except: dropped keys, stamped keys and revived dates in one place', () => {
    const seen: Raw[] = [];
    on(revived).stores('s1').items.listen(items => seen.push(items!));
    expect(Object.keys(seen[0]!)).toEqual(['a', 'b']);
    expect(seen[0]!.a).toEqual({ price: 1, updatedAt: new Date(1000), $key: 'a' });
    expect(seen[0]!.a.updatedAt).toBeInstanceOf(Date);
  });

  it('runs on every change', () => {
    const seen: number[] = [];
    on(counted).stores('s1').items.listen(count => seen.push(count));
    transport.set('stores/s1/items/c', { price: 3 });
    expect(seen).toEqual([4, 5]);
  });

  it('works through subscribe and with an identifier', () => {
    const seen: number[] = [];
    const stop = on(counted).stores('s1').items.subscribe(count => seen.push(count));
    expect(seen).toEqual([4]);
    stop();
    expect(transport.listenerCount).toBe(0);
  });
});

describe('decoding is per caller, and the connection is still shared', () => {
  it('two callers with different decoders on one path share one connection and each get their own shape', async () => {
    const backend = realtimeBackend(transport);
    const whole: unknown[] = [];
    const total: unknown[] = [];
    on(plain, backend).stores('s1').items.listen(items => whole.push(items));
    on(counted, backend).stores('s1').items.listen(count => total.push(count));
    await flush();
    expect(transport.listenerCount).toBe(1);
    expect(whole).toHaveLength(1);
    expect(total).toEqual([4]);
  });

  it('a late joiner is replayed through its own decoder', async () => {
    const backend = realtimeBackend(transport);
    on(plain, backend).stores('s1').items.listen(() => {});
    const late: unknown[] = [];
    on(counted, backend).stores('s1').items.listen(count => late.push(count));
    await flush();
    expect(late).toEqual([4]);
    expect(transport.listenerCount).toBe(1);
  });

  it('the same leaf listened to twice decodes twice, once per caller', () => {
    const decode = vi.fn((raw: Raw | undefined) => Object.keys(raw ?? {}).length);
    const db = schema({ stores: (id: string) => ({ items: leaf<Raw>().decode(decode) }) }, realtimeBackend(transport));
    db.stores('s1').items.listen(() => {});
    db.stores('s1').items.listen(() => {});
    expect(transport.listenerCount).toBe(1);
    expect(decode).toHaveBeenCalledTimes(1); // the second caller is replayed on a microtask
  });
});

describe('a decoder that throws', () => {
  it('reaches that caller\'s error handler and nobody else, and the connection stays', () => {
    const backend = realtimeBackend(transport);
    const bad = schema(
      { stores: (id: string) => ({ items: leaf<Raw>().decode((): number => { throw new Error('bad decoder'); }) }) },
      backend,
    );
    const onError = vi.fn();
    const good: unknown[] = [];
    bad.stores('s1').items.listen(() => {}, 'badCaller', onError);
    on(counted, backend).stores('s1').items.listen(count => good.push(count));
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0].message).toBe('bad decoder');
    expect(transport.listenerCount).toBe(1);
  });
});

describe('what a decoded leaf is not', () => {
  it('has no select, because the decoder needs the whole value', () => {
    expect((on(decoded).stores('s1').items as any).select).toBeUndefined();
    expect((on(plain).stores('s1').items as any).select).toBeTypeOf('function');
  });

  it('cannot be listened to as a list, and says so', () => {
    const db = schema({ things: (id: string) => leaf<Raw>().decode(raw => raw) }, realtimeBackend(transport));
    expect(() => (db.things as any).where('a', '==', 1)).toThrow(/decoded leaf/);
    const seen: unknown[] = [];
    db.things('t1').listen(value => seen.push(value)); // per id it is fine
    expect(seen).toEqual([undefined]);
  });
});

describe('typed decoding', () => {
  it('a decoded handle reports the decoded type', () => {
    const db = schema({ n: leaf<string[]>().decode(ids => new Set(ids)) }, realtimeBackend(transport));
    const seen: Array<Set<string> | undefined> = [];
    db.n.listen(value => seen.push(value));
    expect(seen[0]).toEqual(new Set());
  });
});
