import { normalizeAttributes } from '../core/plan';
import type { AttributeChange, AttributeName } from '../core/types';
import type { Backend } from '../listen/types';
import { CollectionQuery } from './collection';
import { listenable, makeListen, readOnce, readOptions, type Context, type Listenable, type ReadOptions } from './context';

const LEAF = Symbol.for('wherelive.leaf');

type Decoder = (value: any) => any;

/** A value at a path. `from` and `listen` are allowed here, and only here. */
export interface Leaf<T> {
  /** Type-only. There is no such property at runtime. */
  readonly __leaf: T;
  /**
   * Turn the raw value into what your code wants: revive dates, stamp keys, drop
   * fields. `raw` is `undefined` when the node does not exist. Runs once per
   * caller. Do not mutate `raw`, since the connection's value is shared.
   */
  decode<U>(decode: (raw: T | undefined) => U): DecodedLeaf<U>;
  /** Drop these keys at the root of an object value, on a copy. A node that does not exist stays `undefined`. */
  except<K extends keyof T & string>(...keys: K[]): DecodedLeaf<Omit<T, K> | undefined>;
}

/** A leaf whose value is decoded before your callback sees it. It is listened to whole: there is no `select`, and it cannot be a list. */
export interface DecodedLeaf<T> {
  /** Type-only. There is no such property at runtime. */
  readonly __decoded: T;
  /** Decode again. Receives what the previous step returned. */
  decode<U>(decode: (value: T) => U): DecodedLeaf<U>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function omitKeys(keys: readonly string[]): Decoder {
  return value => {
    if (!isRecord(value)) return value;
    const copy = { ...value };
    for (const key of keys) delete copy[key];
    return copy;
  };
}

function makeLeaf(decoders: readonly Decoder[]): object {
  return {
    [LEAF]: decoders,
    decode: (decode: Decoder) => makeLeaf([...decoders, decode]),
    except: (...keys: string[]) => makeLeaf([...decoders, omitKeys(keys)]),
  };
}

export function leaf<T>(): Leaf<T> {
  return makeLeaf([]) as unknown as Leaf<T>;
}

const isLeaf = (value: unknown): boolean => typeof value === 'object' && value !== null && LEAF in value;
const decodersOf = (node: unknown): readonly Decoder[] => (node as { [LEAF]: readonly Decoder[] })[LEAF];

const GROUP = Symbol.for('wherelive.collectionGroup');

/** A collection group: every collection called `name`, wherever it sits in the database. Firestore only. */
export interface CollectionGroup<T> {
  /** Type-only. There is no such property at runtime. */
  readonly __group: T;
}

/**
 * Query every collection with the same name at once, as Firestore's `collectionGroup` does. The property name is
 * the collection's name unless you pass one. Rows carry their document id as the key, not their parent.
 *
 * ```ts
 * schema({ lines: collectionGroup<Line>() }, firestoreBackend(transport)).lines.where('sku', '==', 'a').get()
 * ```
 */
export function collectionGroup<T>(name?: string): CollectionGroup<T> {
  return { [GROUP]: name } as unknown as CollectionGroup<T>;
}

const isGroup = (value: unknown): boolean => typeof value === 'object' && value !== null && GROUP in value;

/** A function is an id segment. An object is the next segment. A `leaf` is where the path ends. */
type SchemaNode = Leaf<any> | DecodedLeaf<any> | CollectionGroup<any> | SchemaObject | ((id: any) => SchemaNode);
export interface SchemaObject {
  readonly [segment: string]: SchemaNode;
}

// ---- what the schema turns into ---------------------------------------------

/** A node you can listen to whole or read once. `get` resolves to `undefined` when the node does not exist. */
type ValueHandle<T> = Listenable<T | undefined> & { get(options?: string | ReadOptions): Promise<T | undefined> };

type NodeSelect<T> = T extends readonly unknown[]
  ? unknown
  : T extends object
    ? {
        /** Listen to the named attributes. `contact.*` listens to each child of `contact`. `*` is the whole node. */
        select<A extends AttributeName<T>[]>(
          ...attributes: A
        ): '*' extends A[number] ? ValueHandle<T> : Listenable<AttributeChange<T, A[number]>>;
      }
    : unknown;

export type LeafHandle<T> = ValueHandle<T> & NodeSelect<T>;

type FunctionHandle<I, R> = ((id: I) => Handle<R>) & (R extends Leaf<infer T> ? CollectionQuery<T> : unknown);

export type Handle<N> = N extends (id: infer I) => infer R
  ? FunctionHandle<I, R>
  : N extends DecodedLeaf<infer T>
    ? Listenable<T> & { get(options?: string | ReadOptions): Promise<T> }
    : N extends CollectionGroup<infer T>
      ? CollectionQuery<T>
      : N extends Leaf<infer T>
        ? LeafHandle<T>
        : { readonly [K in keyof N]: Handle<N[K]> };

// ---- building ------------------------------------------------------------------

/**
 * The public methods of a list query, read from the class so a new method reaches a schema handle without
 * anyone remembering to list it. Names that start with `_` are internal and are not forwarded.
 */
function publicMethods(prototype: object): Set<string> {
  const names = new Set<string>();
  for (let level: object | null = prototype; level && level !== Object.prototype; level = Object.getPrototypeOf(level)) {
    for (const name of Object.getOwnPropertyNames(level)) {
      if (name === 'constructor' || name.startsWith('_')) continue;
      if (typeof Object.getOwnPropertyDescriptor(level, name)?.value === 'function') names.add(name);
    }
  }
  return names;
}
const COLLECTION_METHODS = publicMethods(CollectionQuery.prototype);
const PROBE_ID = '__wherelive_probe__';

const join = (base: string, segment: string): string => (base ? `${base}/${segment}` : segment);

/** Every handle the schema builds, mapped to its path. Keyed by the handle itself, so no name in your schema can collide with it. */
const paths = new WeakMap<object, string>();
const register = <H extends object>(handle: H, path: string): H => {
  paths.set(handle, path);
  return handle;
};

/**
 * The path a handle listens at, e.g. `summaries/store/store1/productIds`.
 * Use it to write to the same place you read from, so the reader and the
 * writer cannot drift apart. Ids are sanitized, so it is the exact path used.
 * A list handle returns the path of the list.
 *
 * ```ts
 * set(ref(rtdb, pathOf(db.summaries.store(storeId).productIds)), ids);
 * ```
 */
export function pathOf(handle: object): string {
  const path = paths.get(handle);
  if (path === undefined) throw new Error('pathOf: this is not a handle from schema().');
  return path;
}

function checkSegment(segment: string, path: string): string {
  if (segment === '' || segment.includes('/')) {
    throw new Error(`Invalid path segment "${segment}"${path ? ` under "${path}"` : ''}: it must be non-empty and contain no "/".`);
  }
  return segment;
}

/** Listen to a node whole, or read it once, through `decode` when there is one. */
function valueHandle(context: Context, path: string, decode?: (value: unknown) => unknown): object {
  const whole = { path, collection: false, clauses: [], attributes: ['*'] } as const;
  return {
    ...listenable(makeListen(context, whole, true, decode)),
    get: async (options?: string | ReadOptions) => {
      const { identifier, source } = readOptions(options);
      const value = await readOnce(context, { path, collection: false, clauses: [], orderBy: [], distinct: false, source }, identifier);
      return decode ? decode(value) : value;
    },
  };
}

function leafHandle(context: Context, path: string, decoders: readonly Decoder[]): object {
  if (decoders.length > 0) return valueHandle(context, path, value => decoders.reduce((current, step) => step(current), value));
  return {
    ...valueHandle(context, path),
    select: (...attributes: string[]) => {
      const names = normalizeAttributes(attributes);
      if (names[0] === '*') return valueHandle(context, path);
      return listenable(makeListen(context, { path, collection: false, clauses: [], attributes: names }, false));
    },
  };
}

function functionHandle(segmentFn: (id: any) => SchemaNode, path: string, context: Context): unknown {
  const call = (id: string | number) => {
    const segment = checkSegment(context.sanitizeId(String(id)), path);
    return build(segmentFn(id), join(path, segment), context);
  };
  let verified = false;
  const collection = (): CollectionQuery<any> => {
    if (!verified) {
      const probe = segmentFn(PROBE_ID);
      if (!isLeaf(probe)) {
        throw new Error(`"${path}" is not a list of leaves. Only a function that returns leaf<T>() can be filtered, selected or listened to as a list.`);
      }
      if (decodersOf(probe).length > 0) {
        throw new Error(`"${path}" returns a decoded leaf, which is listened to whole per id and cannot be a list. Decode the rows yourself.`);
      }
      verified = true;
    }
    return new CollectionQuery<any>(context, path, { clauses: [] });
  };
  const handle = new Proxy(call, {
    get(target, property, receiver) {
      if (typeof property === 'string' && COLLECTION_METHODS.has(property)) {
        return (...args: unknown[]) => (collection() as any)[property](...args);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return register(handle, path);
}

function build(node: SchemaNode, path: string, context: Context): unknown {
  if (isGroup(node)) {
    const name = (node as unknown as { [GROUP]?: string })[GROUP] ?? (path.split('/').pop() as string);
    return register(new CollectionQuery<any>(context, name, { clauses: [] }, undefined, true), name);
  }
  if (isLeaf(node)) return register(leafHandle(context, path, decodersOf(node)), path);
  if (typeof node === 'function') return functionHandle(node, path, context);
  const segments: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(node)) {
    segments[checkSegment(name, path)] = build(child, join(path, name), context);
  }
  return register(segments, path);
}

export interface SchemaOptions {
  backend?: Backend;
  /**
   * Runs on every id before it becomes a path segment, so callers stop cleaning
   * keys by hand. Property names in the schema are not touched. The result must
   * be non-empty and contain no `/`.
   */
  sanitizeId?: (id: string) => string;
}

const isBackend = (value: Backend | SchemaOptions | undefined): value is Backend =>
  typeof value === 'object' && value !== null && typeof (value as Backend).listen === 'function';

/**
 * Describe the paths once per project. The property name is the path segment,
 * so the schema and the writer use the same name.
 *
 * `from` works without a backend. `listen` needs one:
 * `schema(definition, realtimeBackend(transport))`, or
 * `schema(definition, { backend, sanitizeId })` to also clean ids.
 */
export function schema<D extends SchemaObject>(definition: D, backendOrOptions?: Backend | SchemaOptions): Handle<D> {
  const options: SchemaOptions = isBackend(backendOrOptions) ? { backend: backendOrOptions } : (backendOrOptions ?? {});
  return build(definition, '', { backend: options.backend, sanitizeId: options.sanitizeId ?? (id => id) }) as Handle<D>;
}
