import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { doc, setDoc } from 'firebase/firestore';
import { ListQuery, UnsupportedQueryError, firestoreBackend, leaf, schema } from '../src';
import { firebaseFirestoreTransport } from '../src/firebase';
import { clearFirestore, connectFirestore } from './env';

// Orders by the key and what the emulator does with them, through the library and not just the transport: the
// library must answer every one of these as the rows say, and must not send the queries the emulator refuses.

interface Row {
  n: number;
  name: string;
  tag: string;
}
const rows = Array.from({ length: 9 }, (_, index): Row => ({ n: (index + 1) % 3, name: `x${index + 1}`, tag: (index + 1) % 2 ? 'a' : 'b' }));
const withKey = rows.map((row, index) => ({ ...row, $key: `i0${index + 1}` }));

const connection = connectFirestore();
beforeAll(async () => {
  await clearFirestore();
  for (const [index, row] of rows.entries()) await setDoc(doc(connection.firestore, `items/i0${index + 1}`), row);
});
afterAll(async () => {
  await clearFirestore();
  await connection.close();
});
const database = () => schema({ items: (id: string) => leaf<Row>() }, firestoreBackend(firebaseFirestoreTransport(connection.firestore)));

const plans: Array<[string, (q: any) => any]> = [
  ['a range on another field, ordered by the key, with a limit', q => q.where('n', '>=', 1).orderBy('$key').limit(3)],
  ['!= on another field, ordered by the key, with a limit', q => q.where('n', '!=', 1).orderBy('$key').limit(3)],
  ['a range on another field, ordered by the key, last rows', q => q.where('n', '>=', 1).orderBy('$key').limitToLast(3)],
  ['ordered by the key and then another field, with a limit', q => q.orderBy('$key').orderBy('n').limit(3)],
  ['a range on another field, ordered by the key, after a cursor', q => q.where('n', '>=', 1).orderBy('$key').startAfter('i02').limit(3)],
  ['a range on another field, ordered by the key, no limit', q => q.where('n', '>=', 1).orderBy('$key')],
  ['ordered by another field, then the key descending', q => q.orderBy('n').orderBy('$key', 'desc').limit(3)],
  ['an equality, ordered by the key descending, with a limit', q => q.where('tag', '==', 'a').orderBy('$key', 'desc').limit(2)],
  ['ordered by the key ascending with a limit', q => q.orderBy('$key').limit(3)],
  ['ordered by the key descending, with no limit', q => q.orderBy('$key', 'desc')],
  ['a range on the key, ordered by the key, with a limit', q => q.where('$key', '>', 'i03').orderBy('$key').limit(2)],
  ['in on the key, ordered by the key, with a limit', q => q.whereIn('$key', ['i01', 'i05', 'i07']).orderBy('$key').limit(2)],
  ['in on the key, ordered by the key descending, with a limit', q => q.whereIn('$key', ['i01', 'i05', 'i07', 'nope']).orderBy('$key', 'desc').limit(2)],
  ['== on the key, ordered by the key descending', q => q.where('$key', '==', 'i05').orderBy('$key', 'desc').limit(1)],
  ['ordered by the key after a cursor', q => q.orderBy('$key').startAfter('i03').limit(2)],
];

describe('an order by the key, on the real emulator', () => {
  it.each(plans)('%s', async (_name, plan) => {
    const got = await plan(database().items.withKey('$key')).get();
    expect(got).toEqual(plan(ListQuery.from(withKey)).toList());
  });

  it('a backwards scan of the keys that nothing narrows is refused, and the refusal says what to do', async () => {
    const refused = await database().items.withKey('$key').orderBy('$key', 'desc').limit(3).get().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UnsupportedQueryError);
    expect((refused as Error).message).toMatch(/descending key scans.*ascending.*equality filter.*without a limit/);
  });

  it('a live list that cannot be cut on the server says so before it connects', () => {
    expect(() => database().items.withKey('$key').where('n', '>=', 1).orderBy('$key').limit(3).select('name').listen(() => {})).toThrow(/puts the key last/);
  });
});
