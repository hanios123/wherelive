import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectDatabaseEmulator, getDatabase, goOffline, type Database } from 'firebase/database';
import { connectFirestoreEmulator, initializeFirestore, terminate, type Firestore } from 'firebase/firestore';

/** Starts with `demo-`, so the emulators never reach a real project and no login is needed. */
export const PROJECT = 'demo-wherelive';
export const DATABASE_NAMESPACE = `${PROJECT}-default-rtdb`;

function hostOf(variable: 'FIRESTORE_EMULATOR_HOST' | 'FIREBASE_DATABASE_EMULATOR_HOST'): { host: string; port: number } {
  const value = process.env[variable];
  if (!value) {
    throw new Error(`${variable} is not set. These tests need the emulators: run them with \`pnpm test:emulator\`, which starts them.`);
  }
  const [host, port] = value.split(':');
  return { host: host as string, port: Number(port) };
}

let counter = 0;

/** A Firestore connected to the emulator, through the real Firebase SDK. */
export function connectFirestore(): { firestore: Firestore; close: () => Promise<void> } {
  const { host, port } = hostOf('FIRESTORE_EMULATOR_HOST');
  const app: FirebaseApp = initializeApp({ projectId: PROJECT }, `firestore-${counter++}`);
  const firestore = initializeFirestore(app, { ignoreUndefinedProperties: true });
  connectFirestoreEmulator(firestore, host, port);
  return {
    firestore,
    close: async () => {
      await terminate(firestore);
      await deleteApp(app);
    },
  };
}

/** A Realtime Database connected to the emulator, through the real Firebase SDK. */
export function connectDatabase(): { database: Database; close: () => Promise<void> } {
  const { host, port } = hostOf('FIREBASE_DATABASE_EMULATOR_HOST');
  const app = initializeApp({ projectId: PROJECT, databaseURL: `https://${DATABASE_NAMESPACE}.firebaseio.com` }, `database-${counter++}`);
  const database = getDatabase(app);
  connectDatabaseEmulator(database, host, port);
  return {
    database,
    close: async () => {
      goOffline(database);
      await deleteApp(app);
    },
  };
}

/** Empty every document. The emulator offers this as a call, so a test starts from nothing. */
export async function clearFirestore(): Promise<void> {
  const { host, port } = hostOf('FIRESTORE_EMULATOR_HOST');
  const response = await fetch(`http://${host}:${port}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Could not clear Firestore: ${response.status}`);
}

/** The emulator lets a request that says it is the owner past the rules, to set up data in places a client may not write. */
const asOwner = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

export async function writeDatabase(path: string, value: unknown): Promise<void> {
  const { host, port } = hostOf('FIREBASE_DATABASE_EMULATOR_HOST');
  const response = await fetch(`http://${host}:${port}/${path.replace(/^\/+/, '')}.json?ns=${DATABASE_NAMESPACE}`, {
    method: 'PUT',
    headers: asOwner,
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`Could not write ${path}: ${response.status} ${await response.text()}`);
}

export const clearDatabase = (): Promise<void> => writeDatabase('', null);

/** Wait until `check` stops throwing, for a listener whose events arrive from a real server. */
export async function eventually<V>(check: () => V, timeoutMs = 8000): Promise<V> {
  const started = Date.now();
  for (;;) {
    try {
      return check();
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

/** Give a listener time to deliver anything it is going to, for a test that expects it to stay quiet. */
export const settle = (ms = 400): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
