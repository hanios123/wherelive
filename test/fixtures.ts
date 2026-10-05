import { leaf, type Holder } from '../src';
import type { MemoryFirestoreTransport } from '../src/testing';
import type { FirestoreTransport } from '../src/transport';

export interface Product {
  id: string;
  price: number;
}

export interface Customer {
  name: string;
  age: number;
  tier: string;
  tags: string[];
  contact: { email: string; phone: string };
}

/** A schema with nested id segments and leaves, plus a keyed list of customers. One definition serves Realtime Database and Firestore. */
export const definition = {
  summaries: {
    store: (storeId: string) => ({
      productIds: leaf<string[]>(),
      featuredIds: leaf<string[]>(),
      byId: leaf<Holder<Product>>(),
    }),
  },
  customers: (id: string) => leaf<Customer>(),
};

export const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** A memory transport without its change feed, which is what a transport written before the feed existed looks like. */
export const snapshotsOnly = (t: MemoryFirestoreTransport): FirestoreTransport => ({
  onDocument: (...args) => t.onDocument(...args),
  onCollection: (...args) => t.onCollection(...args),
  getDocument: (...args) => t.getDocument(...args),
  getCollection: (...args) => t.getCollection(...args),
  getAggregate: (path, query, aggregates) => t.getAggregate(path, query, aggregates),
});
