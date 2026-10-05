import { rng } from './harness.mjs';

export const STATUS = ['open', 'paid', 'shipped', 'cancelled'];
export const TIERS = ['gold', 'silver', 'bronze'];

/** Deterministic order rows: a realistic mix of strings, numbers, Dates, nested objects and arrays. */
export function makeOrders(n, seed = 1) {
  const r = rng(seed);
  const customers = Math.max(1, Math.floor(n / 10));
  const orders = new Array(n);
  for (let i = 0; i < n; i++) {
    orders[i] = {
      id: `o${i}`,
      region: `r${Math.floor(r() * 10)}`,
      status: STATUS[Math.floor(r() * 4)],
      total: Math.round(r() * 10000) / 100,
      qty: 1 + Math.floor(r() * 20),
      placed: new Date(1.7e12 + Math.floor(r() * 1e10)),
      customerId: `c${Math.floor(r() * customers)}`,
      customer: { tier: TIERS[Math.floor(r() * 3)], address: { city: `city${Math.floor(r() * 50)}` } },
      tags: Array.from({ length: Math.floor(r() * 5) }, () => `t${Math.floor(r() * 20)}`),
      note: `n${Math.floor(r() * 1e9).toString(36)}`,
    };
  }
  return orders;
}

export function makeCustomers(count, seed = 2) {
  const r = rng(seed);
  return Array.from({ length: count }, (_, i) => ({ id: `c${i}`, name: `Customer ${i}`, tier: TIERS[Math.floor(r() * 3)] }));
}
