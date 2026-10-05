import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ListenError, leaf, pathOf, realtimeBackend, schema } from '../src';
import { MemoryRealtimeTransport } from '../src/testing';
import { definition } from './fixtures';

let transport: MemoryRealtimeTransport;
beforeEach(() => {
  transport = new MemoryRealtimeTransport();
});

describe('pathOf', () => {
  const db = schema(definition);

  it('returns the path of a leaf, a segment, an id segment and a list', () => {
    expect(pathOf(db.summaries.store('store1').productIds)).toBe('summaries/store/store1/productIds');
    expect(pathOf(db.summaries.store('store1'))).toBe('summaries/store/store1');
    expect(pathOf(db.summaries)).toBe('summaries');
    expect(pathOf(db.customers)).toBe('customers');
    expect(pathOf(db.customers('42'))).toBe('customers/42');
    expect(pathOf(db)).toBe('');
  });

  it('numeric ids become path segments', () => {
    expect(pathOf((db.customers as any)(7))).toBe('customers/7');
  });

  it('is what the reader listens at: the writer and the reader cannot drift apart', () => {
    const paths: string[] = [];
    const spy = new Proxy(transport, {
      get(target, property, receiver) {
        if (property === 'onValue') return (path: string, ...rest: any[]) => (paths.push(path), (target.onValue as any)(path, ...rest));
        return Reflect.get(target, property, receiver);
      },
    });
    const live = schema(definition, realtimeBackend(spy));
    const ids = live.summaries.store('store1').productIds;
    ids.listen(() => {});
    expect(paths).toEqual([pathOf(ids)]);
  });

  it('writing at the path reaches the listener', () => {
    const live = schema(definition, realtimeBackend(transport));
    const ids = live.summaries.store('store1').productIds;
    const seen: unknown[] = [];
    ids.listen(value => seen.push(value));
    transport.set(pathOf(ids), ['p1', 'p2']); // the writer, through the same definition
    expect(seen).toEqual([undefined, ['p1', 'p2']]);
  });

  it('refuses something that is not a handle', () => {
    expect(() => pathOf({})).toThrow(/not a handle/);
    expect(() => pathOf(() => {})).toThrow(/not a handle/);
  });

  it('works on a decoded leaf too', () => {
    const decoded = schema({ a: { b: leaf<string[]>().decode(ids => ids) } });
    expect(pathOf(decoded.a.b)).toBe('a/b');
  });
});

describe('sanitizeId', () => {
  const clean = (id: string) => id.replace(/[.#$[\]/]/g, '_');

  it('cleans every id before it becomes a segment, in the path the listener uses and pathOf returns', () => {
    const db = schema(definition, { backend: realtimeBackend(transport), sanitizeId: clean });
    const ids = db.summaries.store('a.b/c#d').productIds;
    expect(pathOf(ids)).toBe('summaries/store/a_b_c_d/productIds');
    const seen: unknown[] = [];
    transport.set('summaries/store/a_b_c_d/productIds', ['x']);
    ids.listen(value => seen.push(value));
    expect(seen).toEqual([['x']]);
  });

  it('applies to ids of a list too, and not to property names', () => {
    const db = schema(definition, { sanitizeId: clean });
    expect(pathOf(db.customers('u.1'))).toBe('customers/u_1');
    expect(pathOf(db.summaries)).toBe('summaries');
  });

  it('hands the schema function the id you passed, not the cleaned one', () => {
    const seen: string[] = [];
    const db = schema({ a: (id: string) => (seen.push(id), { leafy: leaf<string>() }) }, { sanitizeId: clean });
    pathOf(db.a('x.y'));
    expect(seen).toEqual(['x.y']);
  });

  it('turns numeric ids into strings first', () => {
    const received: unknown[] = [];
    const db = schema(definition, { sanitizeId: id => (received.push(id), id) });
    (db.customers as any)(5);
    expect(received).toEqual(['5']);
  });

  it('still refuses what the cleaner leaves unusable', () => {
    const db = schema(definition, { sanitizeId: () => '' });
    expect(() => db.customers('x')).toThrow(/Invalid path segment/);
    const slashy = schema(definition, { sanitizeId: id => id });
    expect(() => slashy.customers('a/b')).toThrow(/Invalid path segment/);
  });

  it('a permission error names the cleaned path', () => {
    const db = schema(definition, { backend: realtimeBackend(transport), sanitizeId: clean });
    transport.deny('summaries');
    const onError = vi.fn();
    db.summaries.store('a.b').productIds.listen(() => {}, 'connectToStoreProductIds', onError);
    const error = onError.mock.calls[0]![0] as ListenError;
    expect(error.path).toBe('summaries/store/a_b/productIds');
  });

  it('without a cleaner ids are used as given', () => {
    expect(pathOf(schema(definition).customers('a.b'))).toBe('customers/a.b');
  });
});

describe('schema(definition, ...) accepts a backend or options', () => {
  it('a bare backend', () => {
    const seen: unknown[] = [];
    schema(definition, realtimeBackend(transport)).summaries.store('s').productIds.listen(v => seen.push(v));
    expect(seen).toEqual([undefined]);
  });

  it('options with a backend', () => {
    const seen: unknown[] = [];
    schema(definition, { backend: realtimeBackend(transport) }).summaries.store('s').productIds.listen(v => seen.push(v));
    expect(seen).toEqual([undefined]);
  });

  it('options without a backend still cannot listen, and say so', () => {
    expect(() => schema(definition, { sanitizeId: id => id }).summaries.store('s').productIds.listen(() => {})).toThrow(/no backend/);
  });
});
