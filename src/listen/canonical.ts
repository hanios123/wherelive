import type { Clause } from '../core/plan';
import type { ListenRequest } from './types';

const predicateIds = new WeakMap<object, number>();
let nextPredicateId = 1;

function sortKeys(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = (value as Record<string, unknown>)[key];
  return sorted;
}

function encodeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('A where value must be plain data. Use where(item => boolean) for a check.');
  }
  return JSON.stringify(value, (_key, inner) => sortKeys(inner));
}

function encodeClause(clause: Clause): string {
  switch (clause.kind) {
    case 'compare':
      return `c:${clause.field}:${clause.op}:${encodeValue(clause.value)}`;
    case 'includes':
      return `i:${clause.field}:${encodeValue(clause.value)}`;
    case 'in':
    case 'notIn':
    case 'includesAny':
      // The order of the values does not change the result.
      return `${clause.kind}:${clause.field}:${clause.values.map(encodeValue).sort().join(',')}`;
    case 'or':
      // Neither does the order of the alternatives, or of the conditions in one.
      return `or:[${clause.groups.map(group => `[${group.map(encodeClause).sort().join(';')}]`).sort().join('|')}]`;
    case 'predicate': {
      // A function cannot be compared by content. The same function instance shares. Two instances do not.
      let id = predicateIds.get(clause.test);
      if (id === undefined) predicateIds.set(clause.test, (id = nextPredicateId++));
      return `p:${id}`;
    }
  }
}

/**
 * The identity used to share one connection. Deterministic and built from
 * everything that changes the backend result: store, path, constraints and
 * selected attributes. Never the identity of the query object.
 */
export function canonicalKey(kind: string, request: ListenRequest): string {
  const order = (request.orderBy ?? []).map(key => `${typeof key.by === 'string' ? key.by : 'fn'}:${key.direction}${key.locale ? ':locale' : ''}`);
  const bound = (part: { values: readonly unknown[]; inclusive: boolean } | undefined) =>
    part ? [part.values.map(encodeValue), part.inclusive] : null;
  return JSON.stringify([
    kind,
    request.path,
    request.collection,
    request.group ?? false,
    request.keyField ?? null,
    [...new Set(request.attributes)].sort(),
    request.clauses.map(encodeClause).sort(),
    order,
    bound(request.cursor?.start),
    bound(request.cursor?.end),
    request.limit ?? null,
    request.limitLast ?? null,
  ]);
}
