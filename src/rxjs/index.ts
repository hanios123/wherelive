import { Observable } from 'rxjs';
import type { ListenFn } from '../schema/context';

/** Anything you can `listen` to: a leaf, a selected node, a keyed list query. */
export interface Listens<Change> {
  listen: ListenFn<Change>;
}

/**
 * Turn a `listen` into an Observable. Nothing connects until someone
 * subscribes, and unsubscribing (or `take`, `takeUntilDestroyed`, an error)
 * calls `stop()`. Each subscriber is its own caller, so subscribers share one
 * connection and the last one detaches it. No `shareReplay` is needed for that.
 *
 * `identifier` names the caller in a permission error. A denied listen reaches
 * the subscriber as an ordinary Observable error.
 *
 * ```ts
 * const ids$ = observe(db.summaries.store(storeId).productIds, 'connectToStoreProductIds');
 * ```
 *
 * Angular: `toSignal(ids$)` works on the result as it is.
 */
export function observe<Change>(source: Listens<Change>, identifier?: string): Observable<Change> {
  return new Observable<Change>(subscriber =>
    source.listen(
      change => subscriber.next(change),
      identifier,
      error => subscriber.error(error),
    ),
  );
}
