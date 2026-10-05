import { show, type FirestoreIndex, type IndexAdvice, type QueryExplanation } from '../listen/explain';
import type { FirestoreFilter, FirestoreQuery, FirestoreWhere } from './backend';

/** What a query calls a row's own key. The same name as `DOCUMENT_ID`, kept here because `backend.ts` imports this file. */
const KEY = '__name__';

const nameOf = (field: string): string => (field === KEY ? 'the key' : field);
const describeWhere = (filter: FirestoreWhere): string => `${nameOf(filter.field)} ${filter.op} ${show(filter.value)}`;
const describeFilter = (filter: FirestoreFilter): string =>
  'any' in filter ? filter.any.map(group => `(${group.map(describeWhere).join(' and ')})`).join(' or ') : describeWhere(filter);

/** What a query sent to Firestore says, in words. `chunk` is an `in` that was too long and went as several queries. */
export function describeFirestoreQuery(path: string, query: FirestoreQuery, chunk?: { index: number; size: number }): string[] {
  const lines = [query.group ? `every collection called "${path}"` : `the collection "${path}"`];
  query.where.forEach((filter, index) => {
    const values = !('any' in filter) && Array.isArray(filter.value) ? filter.value.length : 0;
    const split = chunk && chunk.index === index ? ` (sent as ${Math.ceil(values / chunk.size)} queries of up to ${chunk.size} values each)` : '';
    lines.push(`${describeFilter(filter)}${split}`);
  });
  if (query.orderBy.length > 0) lines.push(`order by ${query.orderBy.map(key => `${nameOf(key.field)} ${key.direction === 'desc' ? 'descending' : 'ascending'}`).join(', then ')}`);
  if (query.start) lines.push(`start ${query.start.inclusive ? 'at' : 'after'} ${show(query.start.values)}`);
  if (query.end) lines.push(`end ${query.end.inclusive ? 'at' : 'before'} ${show(query.end.values)}`);
  if (query.limit !== undefined) lines.push(`limit ${query.limit}`);
  return lines;
}

const unique = <V>(values: readonly V[]): V[] => [...new Set(values)];
type IndexField = FirestoreIndex['fields'][number];

/**
 * Which indexes Firestore needs to run this query, from its own documentation:
 *  - automatic single-field indexes serve equality on any number of fields, `in`, a range on one field, and an order on one field;
 *  - a compound query with a range, or one sorted by a different field, needs a composite index;
 *  - an `array-contains` beside other conditions is advised one, to avoid merging single-field indexes;
 *  - a composite index lists equality fields, then sort fields, then range fields;
 *  - the key is always last in an index, and sorting by it in the other direction needs that index;
 *  - a collection group query with a filter or an order needs an index with collection group scope;
 *  - range or inequality filters beside only equality on the key are not supported, and at most 10 range fields are allowed.
 * An `or` is not covered by what was read, so it says so and claims nothing.
 */
export function firestoreIndexAdvice(path: string, query: FirestoreQuery): IndexAdvice[] {
  const flat: FirestoreWhere[] = [];
  for (const filter of query.where) {
    if ('any' in filter) {
      return [
        {
          kind: 'unknown',
          because:
            "This query has an or. The documentation read for this advice does not say how the alternatives of an or are indexed, so nothing is claimed. If an index is missing, Firestore's error message links to the one to create.",
        },
      ];
    }
    flat.push(filter);
  }

  const equality: string[] = [];
  const arrays: string[] = [];
  const ranges: string[] = [];
  let onKey = 0;
  let onKeyBeyondEquality = false;
  for (const filter of flat) {
    if (filter.field === KEY) {
      onKey++;
      if (filter.op !== '==' && filter.op !== 'in') onKeyBeyondEquality = true;
      continue;
    }
    const into = filter.op === '==' || filter.op === 'in' ? equality : filter.op === 'array-contains' || filter.op === 'array-contains-any' ? arrays : ranges;
    if (!into.includes(filter.field)) into.push(filter.field);
  }

  if (ranges.length > 0 && onKey > 0 && !onKeyBeyondEquality) {
    return [{ kind: 'unsupported', because: 'Firestore does not support range or inequality filters on fields together with only equality conditions on the key.' }];
  }
  if (ranges.length > 10) return [{ kind: 'unsupported', because: 'Firestore limits the number of range or inequality fields to 10.' }];

  const sort = query.orderBy.filter(key => key.field !== KEY);
  const byKey = query.orderBy.find(key => key.field === KEY);
  const sortFields = unique(sort.map(key => key.field));
  const fields = unique([...equality, ...arrays, ...ranges, ...sortFields]);
  const advice: IndexAdvice[] = [];

  if (fields.length === 0) {
    if (byKey?.direction === 'desc') {
      advice.push({
        kind: 'unknown',
        because: 'The key in the non-default direction needs an index created for it, according to the index documentation. It does not say whether a bare descending order by the key is served without one.',
      });
    }
  } else {
    const onlyEquality = arrays.length === 0 && ranges.length === 0 && sortFields.length === 0;
    const indexFields: IndexField[] = [];
    const add = (field: IndexField): void => {
      if (!indexFields.some(have => have.fieldPath === field.fieldPath)) indexFields.push(field);
    };
    // equality and array conditions first, in the order the query gives them, then the sort, then the ranges
    for (const filter of flat) {
      if (filter.field === KEY) continue;
      if (filter.op === '==' || filter.op === 'in') add({ fieldPath: filter.field, order: 'ASCENDING' });
      else if (filter.op === 'array-contains' || filter.op === 'array-contains-any') add({ fieldPath: filter.field, arrayConfig: 'CONTAINS' });
    }
    for (const key of sort) add({ fieldPath: key.field, order: key.direction === 'desc' ? 'DESCENDING' : 'ASCENDING' });
    for (const field of ranges) add({ fieldPath: field, order: 'ASCENDING' });

    // The key is added last and takes the direction of the field before it. Any other direction is an index of its own.
    let keyNeedsIndex = false;
    if (byKey) {
      const last = indexFields[indexFields.length - 1] as IndexField;
      const lastDirection = 'order' in last ? last.order : 'ASCENDING';
      const wanted = byKey.direction === 'desc' ? 'DESCENDING' : 'ASCENDING';
      if (wanted !== lastDirection) {
        indexFields.push({ fieldPath: KEY, order: wanted });
        keyNeedsIndex = true;
      }
    }

    const manual = fields.length > 1 && !onlyEquality;
    if (manual || keyNeedsIndex) {
      const reasons: string[] = [];
      if (ranges.length > 0) reasons.push('A compound query with a range or an inequality needs a composite index.');
      if (sortFields.length > 0 && fields.length > 1) reasons.push('A query sorted by a different field than it filters on needs a composite index.');
      if (arrays.length > 0 && ranges.length === 0 && sortFields.length === 0) reasons.push('An array-contains beside other conditions is advised a composite index, to avoid the cost of merging single-field indexes.');
      if (keyNeedsIndex) reasons.push('Sorting by the key in the other direction than the field before it needs that index created.');
      reasons.push('Its fields are listed as the documentation orders them: equality, then sort, then range.');
      if (ranges.length > 1) reasons.push('With several range fields, the documentation advises ordering them by how selective they are. That cannot be known from the query, so they are in the order given.');
      advice.push({
        kind: 'composite',
        need: ranges.length > 0 || sortFields.length > 0 || keyNeedsIndex ? 'required' : 'recommended',
        index: { collectionGroup: path.split('/').pop() as string, queryScope: query.group ? 'COLLECTION_GROUP' : 'COLLECTION', fields: indexFields },
        because: reasons.join(' '),
      });
    }
  }

  if (query.group && (flat.length > 0 || query.orderBy.length > 0) && !advice.some(item => item.kind === 'composite')) {
    advice.push({
      kind: 'collection-group',
      fields: fields.length > 0 ? fields : [KEY],
      because: 'A collection group query that filters or orders needs an index with collection group scope, even when a single field would do.',
    });
  }
  return advice;
}

/**
 * The composite indexes a set of explained queries need, as `firestore.indexes.json` holds them. Only the required ones
 * unless you ask for `recommended` too. Indexes that repeat are listed once. Collection group scope for one field is not
 * written here: it replaces that field's other indexes in the file, so it is better made in the console.
 */
export function firestoreIndexes(explanations: readonly QueryExplanation[], options: { recommended?: boolean } = {}): { indexes: FirestoreIndex[] } {
  const found = new Map<string, FirestoreIndex>();
  for (const explanation of explanations) {
    for (const item of explanation.indexes) {
      if (item.kind === 'composite' && (item.need === 'required' || options.recommended)) found.set(JSON.stringify(item.index), item.index);
    }
  }
  return { indexes: [...found.values()].map(index => ({ collectionGroup: index.collectionGroup, queryScope: index.queryScope, fields: index.fields.map(field => ({ ...field })) })) };
}
