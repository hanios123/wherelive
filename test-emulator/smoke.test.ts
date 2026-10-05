import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { doc, setDoc } from 'firebase/firestore';
import { ref, set } from 'firebase/database';
import { firebaseFirestoreTransport, firebaseRealtimeTransport } from '../src/firebase';
import { clearDatabase, clearFirestore, connectDatabase, connectFirestore } from './env';

const firestoreConnection = connectFirestore();
const databaseConnection = connectDatabase();
afterAll(async () => {
  await firestoreConnection.close();
  await databaseConnection.close();
});
beforeEach(async () => {
  await clearFirestore();
  await clearDatabase();
});

describe('the emulators are there and the adapters can talk to them', () => {
  it('Firestore: write with the SDK, read back through the adapter', async () => {
    await setDoc(doc(firestoreConnection.firestore, 'items/a'), { n: 1 });
    const transport = firebaseFirestoreTransport(firestoreConnection.firestore);
    expect(await transport.getDocument('items/a')).toEqual({ n: 1 });
    expect(await transport.getCollection('items', { where: [], orderBy: [] })).toEqual([{ id: 'a', data: { n: 1 } }]);
  });

  it('Realtime Database: write with the SDK, read back through the adapter', async () => {
    await set(ref(databaseConnection.database, 'items/a'), { n: 1 });
    const transport = firebaseRealtimeTransport(databaseConnection.database);
    expect(await transport.getValue('items/a')).toEqual({ n: 1 });
  });
});
