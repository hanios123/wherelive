import { describeClause, type Clause } from '../core/plan';
import { UnsupportedQueryError } from './errors';

/**
 * What a backend can do on the server. The public API never claims a clause is
 * server-side when it is not: the rest either runs locally or is refused.
 */
export interface Capabilities {
  readonly name: string;
  /** Can the server run `clause`, given how many clauses it already runs? */
  isNative(clause: Clause, nativeSoFar: number): boolean;
  /** `'local'` runs the leftovers on the rows that arrive. `'reject'` refuses the query. */
  readonly leftovers: 'local' | 'reject';
  /** Said when a clause is refused. */
  readonly hint: string;
}

/**
 * Split clauses into what the server runs and what is left. A live listen may refuse the
 * leftovers; a one-time read (`allowLocal`) always finishes them locally on the rows it got.
 */
export function planForBackend(
  clauses: readonly Clause[],
  capabilities: Capabilities,
  options: { allowLocal?: boolean } = {},
): { native: Clause[]; local: Clause[] } {
  const native: Clause[] = [];
  const local: Clause[] = [];
  for (const clause of clauses) {
    (capabilities.isNative(clause, native.length) ? native : local).push(clause);
  }
  if (local.length > 0 && capabilities.leftovers === 'reject' && !options.allowLocal) {
    throw new UnsupportedQueryError(
      `${capabilities.name} cannot run "${describeClause(local[0] as Clause)}". ${capabilities.hint}`,
    );
  }
  return { native, local };
}
