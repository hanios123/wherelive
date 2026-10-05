import { describe, expect, it } from 'vitest';
import { ListQuery } from '../src';
import { firstRows } from '../src/core/first-rows';

// A query that reads only a few of many rows picks them instead of sorting them all.
// Everything here checks that picking gives exactly what a plain stable sort would.

interface Row {
  id: number;
  group: number;
  score: number;
}

/** Deterministic rows with many ties, so a wrong tie-break shows up. */
function makeRows(count: number, seed = 7): Row[] {
  let state = seed;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  return Array.from({ length: count }, (_, id) => ({ id, group: Math.floor(next() * 4), score: Math.floor(next() * 12) }));
}

const byScore = (a: Row, b: Row) => a.score - b.score;
const ids = (rows: readonly Row[]) => rows.map(row => row.id);

describe('firstRows', () => {
  for (const size of [0, 1, 2, 7, 60, 400]) {
    const rows = makeRows(size);
    for (const count of [1, 2, 3, 10, size - 1, size, size + 5].filter(value => value >= 1)) {
      it(`${count} of ${size} rows match a stable sort, from the start and from the end`, () => {
        const sorted = [...rows].sort(byScore);
        expect(ids(firstRows(rows, byScore, count))).toEqual(ids(sorted.slice(0, count)));
        expect(ids(firstRows(rows, byScore, count, true))).toEqual(ids(sorted.slice(-count)));
      });
    }
  }

  it('keeps rows that compare equal in the order they came in', () => {
    const rows = Array.from({ length: 50 }, (_, id) => ({ id, group: 0, score: 1 }));
    expect(ids(firstRows(rows, byScore, 5))).toEqual([0, 1, 2, 3, 4]);
    expect(ids(firstRows(rows, byScore, 5, true))).toEqual([45, 46, 47, 48, 49]);
  });

  it('does not change the rows it is given', () => {
    const rows = makeRows(100);
    const before = ids(rows);
    firstRows(rows, byScore, 5);
    expect(ids(rows)).toEqual(before);
  });
});

describe('a query that reads a few rows gives what a full sort would', () => {
  const rows = makeRows(300);
  const sortedBy = (compare: (a: Row, b: Row) => number) => [...rows].sort(compare);
  const byGroupThenScoreDesc = (a: Row, b: Row) => a.group - b.group || b.score - a.score;

  for (const limit of [1, 2, 5, 40, 75, 76, 299, 300, 500]) {
    for (const offset of [0, 3, 50]) {
      it(`orderBy('score').offset(${offset}).limit(${limit})`, () => {
        expect(ids(ListQuery.from(rows).orderBy('score').offset(offset).limit(limit).toList())).toEqual(ids(sortedBy(byScore).slice(offset, offset + limit)));
      });
    }
    it(`orderBy('score','desc').limit(${limit})`, () => {
      expect(ids(ListQuery.from(rows).orderBy('score', 'desc').limit(limit).toList())).toEqual(ids(sortedBy((a, b) => b.score - a.score).slice(0, limit)));
    });
    it(`orderBy('group').orderBy('score','desc').limit(${limit})`, () => {
      expect(ids(ListQuery.from(rows).orderBy('group').orderBy('score', 'desc').limit(limit).toList())).toEqual(ids(sortedBy(byGroupThenScoreDesc).slice(0, limit)));
    });
    for (const offset of [0, 4]) {
      it(`orderBy('score').offset(${offset}).limitToLast(${limit})`, () => {
        // limitToLast skips the offset first, then keeps the last rows of what is left.
        expect(ids(ListQuery.from(rows).orderBy('score').offset(offset).limitToLast(limit).toList())).toEqual(ids(sortedBy(byScore).slice(offset).slice(-limit)));
      });
    }
  }

  it('filters first, then orders, then cuts', () => {
    const wanted = sortedBy(byScore).filter(row => row.group === 2 && row.score > 3).slice(0, 6);
    expect(ids(ListQuery.from(rows).where('group', '==', 2).where('score', '>', 3).orderBy('score').limit(6).toList())).toEqual(ids(wanted));
  });

  it('applies a cursor before it cuts', () => {
    const after = sortedBy(byScore).filter(row => row.score > 5);
    expect(ids(ListQuery.from(rows).orderBy('score').startAfter(5).limit(9).toList())).toEqual(ids(after.slice(0, 9)));
    const upTo = sortedBy(byScore).filter(row => row.score <= 5);
    expect(ids(ListQuery.from(rows).orderBy('score').endAt(5).limitToLast(9).toList())).toEqual(ids(upTo.slice(-9)));
    expect(ids(ListQuery.from(rows).orderBy('score').startAt(3).endBefore(7).limit(4).toList())).toEqual(ids(sortedBy(byScore).filter(row => row.score >= 3 && row.score < 7).slice(0, 4)));
  });

  it('distinct still finds enough different rows, however many it has to read', () => {
    const groups = sortedBy(byScore).map(row => row.group);
    const distinct = [...new Set(groups)].slice(0, 3);
    expect(ListQuery.from(rows).orderBy('score').select('group').distinct().limit(3).toList()).toEqual(distinct);
  });

  it('first() is the first row of the order', () => {
    expect(ListQuery.from(rows).orderBy('score', 'desc').first()?.id).toBe(sortedBy((a, b) => b.score - a.score)[0]?.id);
    expect(ListQuery.from(rows).orderBy('score').offset(2).first()?.id).toBe(sortedBy(byScore)[2]?.id);
    expect(ListQuery.from(rows).orderBy('score').limit(0).first()).toBeUndefined();
    expect(ListQuery.from(rows).where('score', '>', 999).orderBy('score').first()).toBeUndefined();
    expect(ListQuery.from(rows).orderBy('score').limitToLast(3).first()?.id).toBe(sortedBy(byScore).slice(-3)[0]?.id);
  });

  it('an empty list and a limit larger than the list', () => {
    expect(ListQuery.from<Row>([]).orderBy('score').limit(5).toList()).toEqual([]);
    expect(ListQuery.from<Row>([]).orderBy('score').first()).toBeUndefined();
    expect(ids(ListQuery.from(rows).orderBy('score').limit(10000).toList())).toEqual(ids(sortedBy(byScore)));
  });
});

describe('picking does not sort what it does not read', () => {
  it('reads far fewer keys than a full sort of the same rows would', () => {
    const rows = makeRows(4000);
    let reads = 0;
    const picked = ListQuery.from(rows)
      .orderBy(row => (reads++, row.score))
      .limit(5)
      .toList();
    expect(ids(picked)).toEqual(ids([...rows].sort(byScore).slice(0, 5)));
    const readsToPick = reads;

    reads = 0;
    ListQuery.from(rows)
      .orderBy(row => (reads++, row.score))
      .toList();
    expect(readsToPick).toBeLessThan(reads / 3);
  });

  it('still sorts everything when the query reads most of it', () => {
    const rows = makeRows(4000);
    let reads = 0;
    ListQuery.from(rows)
      .orderBy(row => (reads++, row.score))
      .limit(3000)
      .toList();
    // a full sort of 4000 rows reads each key many times over
    expect(reads).toBeGreaterThan(4000 * 4);
  });
});
