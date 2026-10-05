import type { Subscription, Unsubscribe } from '../core/types';
import { nameListenError } from '../listen/errors';
import type { Backend, ChangeEvent, ListenRequest, NativeAggregate, ReadRequest, ReadSource } from '../listen/types';

export interface Context {
  readonly backend: Backend | undefined;
  /** Runs on every id before it becomes a path segment. */
  readonly sanitizeId: (id: string) => string;
}

/** `identifier` names the caller in a permission error, e.g. `'connectToStoreProductIds'`. */
export type ListenFn<Change> = (next: (change: Change) => void, identifier?: string, onError?: (error: unknown) => void) => Unsubscribe;

/** A handle you can listen to. `subscribe` is the framework-neutral `Subscription` contract over the same lifecycle. */
export interface Listenable<Change> extends Subscription<Change> {
  listen: ListenFn<Change>;
}

const reportError = (error: unknown): void => {
  console.error(error);
};

/**
 * Turn a request into a `listen` function. With `raw`, the caller gets the
 * node's value, passed through `decode` when there is one. Otherwise the caller
 * gets each attribute change.
 *
 * `decode` runs once per caller, on the value the shared connection delivered.
 * A decoder that throws reaches that caller's `onError` and nobody else.
 */
export function makeListen<Change>(
  context: Context,
  request: ListenRequest,
  raw: boolean,
  decode?: (value: unknown) => unknown,
): ListenFn<Change> {
  return (next, identifier, onError) => {
    if (!context.backend) {
      throw new Error('This schema has no backend to listen on. Pass one: schema(definition, realtimeBackend(transport)).');
    }
    return context.backend.listen(request, {
      identifier,
      next: raw
        ? (change: ChangeEvent) => (next as (value: unknown) => void)(decode ? decode(change.value) : change.value)
        : (next as (change: ChangeEvent) => void),
      error: onError ?? reportError,
    });
  };
}

/**
 * Read once through the backend. A denied read is named after the caller, like a denied listen:
 * `PERMISSION_DENIED: Permission denied (get --- <identifier>): ... --- <path>`.
 */
export async function readOnce(context: Context, request: ReadRequest, identifier: string | undefined): Promise<unknown> {
  if (!context.backend) {
    throw new Error('This schema has no backend to read from. Pass one: schema(definition, realtimeBackend(transport)).');
  }
  try {
    return await context.backend.get(request);
  } catch (error) {
    throw nameListenError(error, { identifier, path: request.path, action: 'get' });
  }
}

/** What a one-time read may be told: who is asking, for a permission error, and where Firestore may read from. */
export interface ReadOptions {
  /** Names the caller in a permission error: `Permission denied (get --- <identifier>)`. */
  readonly identifier?: string;
  /** `'server'` and `'cache'` force where Firestore reads from. Realtime Database ignores it. */
  readonly source?: ReadSource;
}

export const readOptions = (options: string | ReadOptions | undefined): ReadOptions => (typeof options === 'string' ? { identifier: options } : (options ?? {}));

/** Ask the database to run aggregates itself. `undefined` means it cannot for this query, and the rows must be read. */
export async function readAggregate(
  context: Context,
  request: ReadRequest,
  aggregates: Readonly<Record<string, NativeAggregate>>,
  identifier: string | undefined,
): Promise<Record<string, number | undefined> | undefined> {
  const backend = context.backend;
  if (!backend?.aggregate) return undefined;
  try {
    return await backend.aggregate(request, aggregates);
  } catch (error) {
    throw nameListenError(error, { identifier, path: request.path, action: 'get' });
  }
}

export function listenable<Change>(listen: ListenFn<Change>): Listenable<Change> {
  return { listen, subscribe: (next, error) => listen(next, undefined, error) };
}
