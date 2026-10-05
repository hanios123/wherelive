import { ListQuery as Q } from '../dist/index.js';
import { fmt, header, measure } from './harness.mjs';
import { makeOrders } from './data.mjs';

const n = Number(process.env.N ?? 10000);
const orders = makeOrders(n);

function compare(title, rows) {
  header(title);
  const results = rows.map(([label, fn]) => [label, measure(fn).median]);
  const best = Math.min(...results.map(r => r[1]));
  for (const [label, ms] of results) console.log(`${label.padEnd(64)}${fmt(ms).padStart(12)}${((ms / best).toFixed(2) + 'x').padStart(8)}${(((ms * 1e6) / n).toFixed(0) + ' ns/row').padStart(14)}`);
}

// H1: is a dotted STRING path slow because it is re-parsed for every row?
compare(`H1  filter on a nested field: string path vs function accessor (n=${n})`, [
  ["where('customer.address.city','==','city7')   dotted string", () => Q.from(orders).where('customer.address.city', '==', 'city7').toList()],
  ["where(o => o.customer.address.city === 'city7') function", () => Q.from(orders).where(o => o.customer.address.city === 'city7').toList()],
  ["where('region','==','r3')                       flat string", () => Q.from(orders).where('region', '==', 'r3').toList()],
  ["where(o => o.region === 'r3')                   function", () => Q.from(orders).where(o => o.region === 'r3').toList()],
]);

// H2: same question for sorting, where the key is read on every comparison.
compare(`H2  orderBy a nested field: string path vs function key (n=${n})`, [
  ["orderBy('customer.address.city')  dotted string", () => Q.from(orders).orderBy('customer.address.city').toList()],
  ["orderBy(o => o.customer.address.city)  function", () => Q.from(orders).orderBy(o => o.customer.address.city).toList()],
  ["orderBy('total')  flat string", () => Q.from(orders).orderBy('total').toList()],
  ["orderBy(o => o.total)  function", () => Q.from(orders).orderBy(o => o.total).toList()],
]);

// H3: does count()/some() pay for a select it does not need?
compare(`H3  count() with and without a select (n=${n})`, [
  ["where(status==open).count()", () => Q.from(orders).where('status', '==', 'open').count()],
  ["where(status==open).select('id','total').count()", () => Q.from(orders).where('status', '==', 'open').select('id', 'total').count()],
  ["where(status==open).select({id, city:'customer.address.city'}).count()", () => Q.from(orders).where('status', '==', 'open').select({ id: 'id', city: 'customer.address.city' }).count()],
]);

// H4: how much of an orderBy is comparing vs reading keys? Sort pre-extracted numbers with the same comparator shape.
compare(`H4  what a sort costs when the key is read once, not per comparison (n=${n})`, [
  ["wherelive orderBy('total')", () => Q.from(orders).orderBy('total').toList()],
  ["native sort, key read per comparison (a.total-b.total)", () => [...orders].sort((a, b) => a.total - b.total)],
  ["native decorate-sort-undecorate (key read once per row)", () => { const d = orders.map(o => [o.total, o]); d.sort((a, b) => a[0] - b[0]); return d.map(x => x[1]); }],
]);

// H5: top-k. limit(10) after orderBy still sorts all rows.
compare(`H5  orderBy + limit(10): does limit shortcut the sort? (n=${n})`, [
  ["orderBy('total').limit(10)", () => Q.from(orders).orderBy('total').limit(10).toList()],
  ["orderBy('total')  no limit", () => Q.from(orders).orderBy('total').toList()],
  ["orderBy('total').limit(1000)", () => Q.from(orders).orderBy('total').limit(1000).toList()],
]);

// H6: fixed per-run cost, as a function of how much of the pipeline is used.
header('H6  fixed cost per query run on an EMPTY list');
for (const [label, fn] of [
  ['Q.from([]).toList()', () => Q.from([]).toList()],
  ["Q.from([]).where('a','==',1).toList()", () => Q.from([]).where('a', '==', 1).toList()],
  ["Q.from([]).where(..).orderBy('a').toList()", () => Q.from([]).where('a', '==', 1).orderBy('a').toList()],
  ["Q.from([]).where(..).select('a','b').limit(5).toList()", () => Q.from([]).where('a', '==', 1).select('a', 'b').limit(5).toList()],
  ['[].filter(..)  native', () => [].filter(o => o.a === 1)],
]) console.log(`${label.padEnd(64)}${fmt(measure(fn).median).padStart(12)}`);
