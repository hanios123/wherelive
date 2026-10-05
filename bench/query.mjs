import { ListQuery as Q } from '../dist/index.js';
import { header, pair, sameIds, sameLength, solo } from './harness.mjs';
import { makeOrders } from './data.mjs';

const sizes = (process.env.SIZES ?? '1000,10000,100000').split(',').map(Number);
const cut = new Date(1.7e12 + 5e9);
const regions5 = ['r1', 'r2', 'r3', 'r4', 'r5'];
const regionSet = new Set(regions5);

header('FILTER  (wherelive vs a hand-written array.filter)');
for (const n of sizes) {
  const orders = makeOrders(n);
  pair('filter', "where('status','==','open')", n,
    () => Q.from(orders).where('status', '==', 'open').toList(),
    () => orders.filter(o => o.status === 'open'), { agree: sameIds });
  pair('filter', "3 x where (==, >=, ==)", n,
    () => Q.from(orders).where('status', '==', 'open').where('total', '>=', 50).where('region', '==', 'r3').toList(),
    () => orders.filter(o => o.status === 'open' && o.total >= 50 && o.region === 'r3'), { agree: sameIds });
  pair('filter', "where('customer.address.city','==',..) dotted", n,
    () => Q.from(orders).where('customer.address.city', '==', 'city7').toList(),
    () => orders.filter(o => o.customer.address.city === 'city7'), { agree: sameIds });
  pair('filter', "whereIn('region', 5 values)", n,
    () => Q.from(orders).whereIn('region', regions5).toList(),
    () => orders.filter(o => regionSet.has(o.region)), { agree: sameIds });
  pair('filter', "whereIncludes('tags','t3')", n,
    () => Q.from(orders).whereIncludes('tags', 't3').toList(),
    () => orders.filter(o => o.tags.includes('t3')), { agree: sameIds });
  pair('filter', "where('placed','>=',Date)  date range", n,
    () => Q.from(orders).where('placed', '>=', cut).toList(),
    () => orders.filter(o => o.placed >= cut), { agree: sameIds });
  pair('filter', "whereAny(a, b)  OR of two groups", n,
    () => Q.from(orders).whereAny(q => q.where('status', '==', 'open').where('region', '==', 'r1'), q => q.where('total', '>', 90)).toList(),
    () => orders.filter(o => (o.status === 'open' && o.region === 'r1') || o.total > 90), { agree: sameIds });
  pair('filter', "where(item => bool)  predicate only", n,
    () => Q.from(orders).where(o => o.status === 'open').toList(),
    () => orders.filter(o => o.status === 'open'), { agree: sameIds });
  pair('filter', "count() of a filter", n,
    () => Q.from(orders).where('status', '==', 'open').count(),
    () => orders.filter(o => o.status === 'open').length, { agree: (a, b) => a === b });
}

header('EARLY EXIT  (lazy: should not scale with n)');
for (const n of sizes) {
  const orders = makeOrders(n);
  pair('early', "first() where status=='paid' (hit ~2 rows in)", n,
    () => Q.from(orders).where('status', '==', 'paid').first(),
    () => orders.find(o => o.status === 'paid'), { agree: (a, b) => a?.id === b?.id });
  pair('early', "some() with no match (full scan)", n,
    () => Q.from(orders).where('status', '==', 'nope').some(),
    () => orders.some(o => o.status === 'nope'), { agree: (a, b) => a === b });
  pair('early', "where + limit(10)", n,
    () => Q.from(orders).where('status', '==', 'open').limit(10).toList(),
    () => orders.filter(o => o.status === 'open').slice(0, 10), { agree: sameIds });
}

header('SORT  (wherelive vs [...arr].sort(comparator))');
for (const n of sizes) {
  const orders = makeOrders(n);
  pair('sort', "orderBy('total')  number", n,
    () => Q.from(orders).orderBy('total').toList(),
    () => [...orders].sort((a, b) => a.total - b.total), { agree: (a, b) => a.length === b.length && a[0].total === b[0].total && a[a.length - 1].total === b[b.length - 1].total });
  pair('sort', "orderBy('total','desc')", n,
    () => Q.from(orders).orderBy('total', 'desc').toList(),
    () => [...orders].sort((a, b) => b.total - a.total), { agree: sameLength });
  pair('sort', "orderBy('note')  unique strings", n,
    () => Q.from(orders).orderBy('note').toList(),
    () => [...orders].sort((a, b) => (a.note < b.note ? -1 : a.note > b.note ? 1 : 0)), { agree: sameIds });
  pair('sort', "orderBy('region'), orderBy('total','desc')", n,
    () => Q.from(orders).orderBy('region').orderBy('total', 'desc').toList(),
    () => [...orders].sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : b.total - a.total)), { agree: sameLength });
  pair('sort', "orderBy('customer.address.city') dotted", n,
    () => Q.from(orders).orderBy('customer.address.city').toList(),
    () => [...orders].sort((a, b) => (a.customer.address.city < b.customer.address.city ? -1 : a.customer.address.city > b.customer.address.city ? 1 : 0)), { agree: sameLength });
  pair('sort', "orderBy('placed')  Date", n,
    () => Q.from(orders).orderBy('placed').toList(),
    () => [...orders].sort((a, b) => a.placed - b.placed), { agree: sameLength });
  if (n <= 10000) {
    const collator = new Intl.Collator();
    pair('sort', "orderBy('note',asc,{locale:true})", n,
      () => Q.from(orders).orderBy('note', 'asc', { locale: true }).toList(),
      () => [...orders].sort((a, b) => collator.compare(a.note, b.note)), { agree: sameLength });
  }
}

header('TOP-K / PAGINATION  (sort everything, then keep a few)');
const topK = (orders, k) => {
  const best = [];
  for (const o of orders) {
    if (best.length === k && o.total >= best[k - 1].total) continue;
    let i = best.length;
    while (i > 0 && best[i - 1].total > o.total) i--;
    best.splice(i, 0, o);
    if (best.length > k) best.pop();
  }
  return best;
};
for (const n of sizes) {
  const orders = makeOrders(n);
  pair('topk', "orderBy('total').limit(10)", n,
    () => Q.from(orders).orderBy('total').limit(10).toList(),
    () => [...orders].sort((a, b) => a.total - b.total).slice(0, 10),
    { agree: (a, b) => a.length === 10 && a[0].total === b[0].total && a[9].total === b[9].total, alt: { name: 'hand-written top-10 scan (no full sort)', fn: () => topK(orders, 10) } });
  pair('topk', "where + orderBy + offset(40).limit(20)", n,
    () => Q.from(orders).where('status', '==', 'open').orderBy('total').offset(40).limit(20).toList(),
    () => orders.filter(o => o.status === 'open').sort((a, b) => a.total - b.total).slice(40, 60), { agree: sameLength });
  pair('topk', "orderBy('total').startAfter(50).limit(20)  keyset", n,
    () => Q.from(orders).orderBy('total').startAfter(50).limit(20).toList(),
    () => orders.filter(o => o.total > 50).sort((a, b) => a.total - b.total).slice(0, 20), { agree: (a, b) => a.length === b.length && a[0].total === b[0].total });
  pair('topk', "orderBy('total','desc').limitToLast(10)", n,
    () => Q.from(orders).orderBy('total', 'desc').limitToLast(10).toList(),
    () => [...orders].sort((a, b) => b.total - a.total).slice(-10), { agree: (a, b) => a.length === 10 && a[0].total === b[0].total });
}

header('FIXED COST  (a UI re-runs small queries on every render)');
const small = makeOrders(50);
const tiny = makeOrders(5);
pair('fixed', "50 rows: where + orderBy + limit(10)", 50,
  () => Q.from(small).where('status', '==', 'open').orderBy('total', 'desc').limit(10).toList(),
  () => small.filter(o => o.status === 'open').sort((a, b) => b.total - a.total).slice(0, 10), { agree: sameLength });
pair('fixed', "5 rows: where('status','==','open')", 5,
  () => Q.from(tiny).where('status', '==', 'open').toList(),
  () => tiny.filter(o => o.status === 'open'), { agree: sameLength });
pair('fixed', "0 rows: where(...).toList()", 0,
  () => Q.from([]).where('status', '==', 'open').toList(),
  () => [].filter(o => o.status === 'open'), { agree: sameLength });
solo('fixed', 'BUILD only: fromType().where x2.orderBy.select.limit', undefined, () => Q.fromType().where('status', '==', 'open').where('total', '>', 5).orderBy('total').select('id', 'total').limit(10));
