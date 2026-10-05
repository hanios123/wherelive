import { ListQuery as Q } from '../dist/index.js';
import { header, pair, sameLength } from './harness.mjs';
import { makeCustomers, makeOrders } from './data.mjs';

const sizes = (process.env.SIZES ?? '1000,10000,100000').split(',').map(Number);
const isOpen = o => o.status === 'open';

header('SELECT / DISTINCT');
for (const n of sizes) {
  const orders = makeOrders(n);
  pair('select', "select('id','total')", n,
    () => Q.from(orders).select('id', 'total').toList(),
    () => orders.map(o => ({ id: o.id, total: o.total })), { agree: sameLength });
  pair('select', "select('total')  single attribute", n,
    () => Q.from(orders).select('total').toList(),
    () => orders.map(o => o.total), { agree: sameLength });
  pair('select', "select({id, city:'customer.address.city', total})", n,
    () => Q.from(orders).select({ id: 'id', city: 'customer.address.city', total: 'total' }).toList(),
    () => orders.map(o => ({ id: o.id, city: o.customer.address.city, total: o.total })), { agree: sameLength });
  pair('select', "select(o => o.total * o.qty)  computed", n,
    () => Q.from(orders).select(o => o.total * o.qty).toList(),
    () => orders.map(o => o.total * o.qty), { agree: sameLength });
  pair('select', "select('region').distinct()  10 distinct", n,
    () => Q.from(orders).select('region').distinct().toList(),
    () => [...new Set(orders.map(o => o.region))], { agree: sameLength });
  pair('select', "select('id','region').distinct()  all unique", n,
    () => Q.from(orders).select('id', 'region').distinct().toList(),
    () => { const seen = new Set(); return orders.map(o => ({ id: o.id, region: o.region })).filter(r => { const k = `${r.id}|${r.region}`; if (seen.has(k)) return false; seen.add(k); return true; }); }, { agree: sameLength });
  // Same query with and without a select: count() never needs the projected row.
  pair('select', "count() where+select('id','total') vs no select*", n,
    () => Q.from(orders).where('status', '==', 'open').select('id', 'total').count(),
    () => Q.from(orders).where('status', '==', 'open').count(), { agree: (a, b) => a === b });
}

header('GROUP BY / AGGREGATE');
for (const n of sizes) {
  const orders = makeOrders(n);
  const groupNative = (keyOf, init, step) => {
    const groups = new Map();
    for (const o of orders) { const k = keyOf(o); let g = groups.get(k); if (!g) groups.set(k, (g = init(o))); step(g, o); }
    return [...groups.values()];
  };
  pair('group', "groupBy('region').aggregate(count,sum,avg)  10 groups", n,
    () => Q.from(orders).groupBy('region').aggregate(a => ({ n: a.count(), total: a.sum('total'), avg: a.avg('total') })).toList(),
    () => groupNative(o => o.region, o => ({ region: o.region, n: 0, total: 0 }), (g, o) => { g.n++; g.total += o.total; }).map(g => ({ ...g, avg: g.total / g.n })), { agree: sameLength });
  pair('group', "groupBy('region','status').aggregate(count)  40 groups", n,
    () => Q.from(orders).groupBy('region', 'status').aggregate(a => ({ n: a.count() })).toList(),
    () => groupNative(o => o.region + '|' + o.status, o => ({ region: o.region, status: o.status, n: 0 }), g => { g.n++; }), { agree: sameLength });
  pair('group', "groupBy('customerId').aggregate(count)  n/10 groups", n,
    () => Q.from(orders).groupBy('customerId').aggregate(a => ({ n: a.count() })).toList(),
    () => groupNative(o => o.customerId, o => ({ customerId: o.customerId, n: 0 }), g => { g.n++; }), { agree: sameLength });
  pair('group', "groupBy('region').aggregate(max,min,collect)", n,
    () => Q.from(orders).groupBy('region').aggregate(a => ({ hi: a.max('total'), lo: a.min('total'), ids: a.collect('id') })).toList(),
    () => groupNative(o => o.region, o => ({ region: o.region, hi: -Infinity, lo: Infinity, ids: [] }), (g, o) => { if (o.total > g.hi) g.hi = o.total; if (o.total < g.lo) g.lo = o.total; g.ids.push(o.id); }), { agree: sameLength });
  pair('group', "aggregate(count,sum)  whole list, 1 row", n,
    () => Q.from(orders).aggregate(a => ({ n: a.count(), total: a.sum('total') })).first(),
    () => { let total = 0; for (const o of orders) total += o.total; return { n: orders.length, total }; }, { agree: (a, b) => a.n === b.n && Math.abs(a.total - b.total) < 1e-6 });
}

header('JOIN  (orders n  x  customers n/10)');
for (const n of sizes) {
  const orders = makeOrders(n);
  const customers = makeCustomers(Math.max(1, Math.floor(n / 10)));
  const joinNative = keepLeft => {
    const index = new Map();
    for (const c of customers) index.set(c.id, c);
    const out = [];
    for (const o of orders) { const c = index.get(o.customerId); if (c) out.push({ left: o, right: c }); else if (keepLeft) out.push({ left: o, right: undefined }); }
    return out;
  };
  pair('join', "innerJoin(customers,'customerId','id')", n,
    () => Q.from(orders).innerJoin(customers, 'customerId', 'id').toList(),
    () => joinNative(false), { agree: sameLength });
  pair('join', "leftJoin(customers,'customerId','id')", n,
    () => Q.from(orders).leftJoin(customers, 'customerId', 'id').toList(),
    () => joinNative(true), { agree: sameLength });
  pair('join', "where + innerJoin + select", n,
    () => Q.from(orders).where('status', '==', 'open').innerJoin(customers, 'customerId', 'id').select(r => r.right.name).toList(),
    () => { const idx = new Map(customers.map(c => [c.id, c])); const out = []; for (const o of orders) if (o.status === 'open') { const c = idx.get(o.customerId); if (c) out.push(c.name); } return out; }, { agree: sameLength });
}

header('UNION / FLATMAP / PAIRS / HOLDER');
for (const n of sizes) {
  const orders = makeOrders(n);
  const head = orders.slice(0, Math.floor(n * 0.6));
  const tail = orders.slice(Math.floor(n * 0.4));
  pair('union', "union(other,'id')  20% overlap", n,
    () => Q.from(head).union(tail, 'id').toList(),
    () => { const seen = new Set(); const out = []; for (const o of head) if (!seen.has(o.id)) { seen.add(o.id); out.push(o); } for (const o of tail) if (!seen.has(o.id)) { seen.add(o.id); out.push(o); } return out; }, { agree: sameLength });
  pair('union', "unionAll(other)", n,
    () => Q.from(head).unionAll(tail).toList(),
    () => head.concat(tail), { agree: sameLength });
  if (n <= 10000) {
    pair('union', "union(other)  whole-row identity (no key)", n,
      () => Q.from(head).union(tail).toList(),
      () => { const seen = new Set(); const out = []; for (const o of head.concat(tail)) { const k = JSON.stringify(o); if (!seen.has(k)) { seen.add(k); out.push(o); } } return out; }, { agree: sameLength });
  }
  const parents = orders.slice(0, Math.floor(n / 10));
  const kids = new Map(parents.map(p => [p.id, Array.from({ length: 10 }, (_, i) => ({ parent: p.id, i }))]));
  pair('flatMap', "flatMap: n/10 parents x 10 children", n,
    () => Q.from(parents).flatMap(p => kids.get(p.id)).toList(),
    () => { const out = []; for (const p of parents) for (const k of kids.get(p.id)) out.push(k); return out; }, { agree: sameLength });
  const holder = Object.fromEntries(orders.map(o => [o.id, o]));
  pair('holder', "fromHolder(holder).where(...)", n,
    () => Q.fromHolder(holder).where('status', '==', 'open').toList(),
    () => Object.values(holder).filter(isOpen), { agree: sameLength });
  pair('holder', "where(...).toHolder('id')", n,
    () => Q.from(orders).where('status', '==', 'open').toHolder('id'),
    () => { const h = {}; for (const o of orders) if (isOpen(o)) h[o.id] = o; return h; }, { agree: (a, b) => Object.keys(a).length === Object.keys(b).length });
}

header('PAIRS / COMBINE  (n = size of the product)');
{
  const dim = Math.round(Math.sqrt(100000));
  const a = Array.from({ length: dim }, (_, i) => i);
  const b = Array.from({ length: dim }, (_, i) => i * 2);
  const n = dim * dim;
  pair('pairs', "pairs(a,b).where(([x,y]) => x+y is even)", n,
    () => Q.pairs(a, b).where(([x, y]) => (x + y) % 2 === 0).toList(),
    () => { const out = []; for (const x of a) for (const y of b) if ((x + y) % 2 === 0) out.push([x, y]); return out; }, { agree: sameLength });
  const l1 = Array.from({ length: 50 }, (_, i) => i), l2 = Array.from({ length: 50 }, (_, i) => i), l3 = Array.from({ length: 40 }, (_, i) => i);
  pair('pairs', "combine({x,y,z}).where(x+y==z)  100k combos", 50 * 50 * 40,
    () => Q.combine({ x: l1, y: l2, z: l3 }).where(r => r.x + r.y === r.z).toList(),
    () => { const out = []; for (const x of l1) for (const y of l2) for (const z of l3) if (x + y === z) out.push({ x, y, z }); return out; }, { agree: sameLength });
}
