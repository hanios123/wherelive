import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pkg from '../package.json';

/**
 * Builds the package the way it is published, with the real `tsup.config.ts` and `package.json`, installs it into a
 * scratch app, and compiles that app with `declaration: true`. That is where a type you stopped exporting shows up:
 * TypeScript refuses to write a `.d.ts` for a value whose type it can only name through an internal file. It also pins
 * the exact public surface, so changing it is a decision and not an accident.
 */

const root = resolve(__dirname, '..');

/** What a consumer of a library would export: values whose types are inferred, and signatures that name our types. */
const consumer = `
import { ListQuery, collectionGroup, firestoreBackend, leaf, pathOf, realtimeBackend, schema } from 'wherelive';
import type { Aggregate, Aggregates, Conditions, Handle, Holder, Listenable, Path, PathValue, ReadOptions, RowChange } from 'wherelive';
import { DOCUMENT_ID } from 'wherelive/transport';
import type { Backend, FirestoreTransport, RealtimeTransport } from 'wherelive/transport';

interface Order { id: string; status: string; total: number; tags: string[]; customer: { city: string } }
interface Line { sku: string; qty: number }

const backend = firestoreBackend(null as never);
const rt = realtimeBackend(null as never);

export const db = schema(
  {
    orders: (id: string) => leaf<Order>(),
    lines: collectionGroup<Line>(),
    stats: { ids: leaf<string[]>().decode(ids => new Set(ids ?? [])), audited: leaf<Holder<Order>>().except('createdBy') },
    plain: leaf<Order>(),
  },
  backend,
);
export const dbRealtime = schema({ orders: (id: string) => leaf<Order>() }, rt);

export const arrayQuery = ListQuery.from<Order>([]).where('status', '==', 'open').orderBy('total').limit(3);
export const selected = ListQuery.from<Order>([]).select('id', 'total');
export const aliased = ListQuery.from<Order>([]).select({ id: 'id', city: 'customer.city' });
export const grouped = ListQuery.from<Order>([]).groupBy('status').aggregate(a => ({ n: a.count(), total: a.sum('total'), all: a.collect() }));
export const joined = ListQuery.from<Order>([]).outerJoin([] as Line[], 'id', 'sku');
export const united = ListQuery.from<Order>([]).union([] as Order[], 'id');
export const paged = ListQuery.from<Order>([]).orderBy('total').startAfter(1).limitToLast(2);
export const anyOf = ListQuery.from<Order>([]).whereAny(a => a.where('status', '==', 'x'), b => b.whereIn('id', ['a']));
export const holder = ListQuery.from<Order>([]).toHolder('id');
export const flat = ListQuery.from<Order>([]).flatMap(order => order.tags);
export const plan = arrayQuery.plan;

export const list = db.orders;
export const oneDoc = db.orders('1');
export const built = db.orders.withKey('$key').whereAny(a => a.where('status', '==', 'x')).orderBy('total').limit(5);
export const named = db.orders.select('id', 'total');
export const columns = db.orders.select({ id: 'id' });
export const computed = db.orders.select(o => o.total * 2);
export const group = db.lines.where('sku', '==', 'a');
export const loaded = db.orders.where('status', '==', 'open').get({ source: 'server' });
export const counted = db.orders.count();
export const totals = db.orders.aggregate(a => ({ n: a.count(), total: a.sum('total'), mean: a.avg('total') }));
export const listener = named.listen;
export const subscription = named.subscribe;
export const decodedLeaf = db.stats.ids;
export const audited = db.stats.audited;
export const leafHandle = db.plain;
export const whole = db.plain.select('*');
export const attrs = db.plain.select('id', 'total');
export const path = pathOf(db.orders);
export const inRealtime = dbRealtime.orders.orderBy('total').limit(2).get();

export function takesQuery(query: ListQuery<Order>): ListQuery<Order> { return query; }
export function takesPath<T>(field: Path<T>): string { return field; }
export function takesValue<T, P extends Path<T>>(value: PathValue<T, P>): PathValue<T, P> { return value; }
export function onChange(change: RowChange<Order, 'id' | 'total'>): void { void change; }
export function options(read: ReadOptions): ReadOptions { return read; }
export function aggregates(build: (a: Aggregates<Order>) => Record<string, Aggregate<unknown>>): void { void build; }
export function conditions(build: (c: Conditions<Order>) => Conditions<Order>): void { void build; }
export function handle(h: Handle<{ x: ReturnType<typeof leaf<string>> }>): void { void h; }
export function listenable(l: Listenable<string>): void { void l; }

export const idField: string = DOCUMENT_ID;
export function transports(f: FirestoreTransport, r: RealtimeTransport, b: Backend): [FirestoreTransport, RealtimeTransport, Backend] { return [f, r, b]; }
`;

/** The public surface. Adding or removing a name here is a decision about the API. */
const MAIN = [
  'Aggregate', 'Aggregates', 'AttributeChange', 'CollectionGroup', 'CollectionQuery', 'Conditions', 'DecodedLeaf', 'Handle', 'Holder',
  'FirestoreIndex', 'IndexAdvice', 'Leaf', 'LeafHandle', 'ListQuery', 'Listenable', 'ListenError', 'Path', 'PathValue', 'QueryExplanation', 'ReadOptions',
  'RowChange', 'SchemaOptions', 'Subscription', 'UnsupportedQueryError', 'Unsubscribe', 'collectionGroup', 'firestoreBackend', 'firestoreIndexes', 'leaf',
  'pathOf', 'realtimeBackend', 'schema',
].sort();
const TRANSPORT = [
  'Backend', 'ChangeEvent', 'ChildHandlers', 'Clause', 'DOCUMENT_ID', 'FirestoreAny', 'FirestoreChange', 'FirestoreCursor', 'FirestoreData', 'FirestoreFilter',
  'FirestoreQuery', 'FirestoreReadOptions', 'FirestoreRow', 'FirestoreTransport', 'FirestoreWhere', 'ListenRequest', 'NativeAggregate',
  'NativeOrder', 'OrderKey', 'QueryPlan', 'ReadRequest', 'ReadRow', 'ReadSource', 'RealtimeBound', 'RealtimeQuery', 'RealtimeScalar',
  'RealtimeTransport', 'Selection', 'Subscriber',
].sort();

let workspace: string;
let installed: string;

const baseOptions = (strict: boolean): ts.CompilerOptions => ({
  strict,
  declaration: true,
  emitDeclarationOnly: true,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
  types: [],
  skipLibCheck: false,
});

function compileConsumer(strict: boolean) {
  const options = baseOptions(strict);
  const program = ts.createProgram([join(workspace, 'app/use.ts')], options);
  const emitted: string[] = [];
  const result = program.emit(undefined, (_name, text) => void emitted.push(text), undefined, true);
  const problems = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics].map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  return { problems, declaration: emitted.join('\n') };
}

function exportsOf(entry: string): string[] {
  const file = join(installed, 'dist', entry);
  const program = ts.createProgram([file], baseOptions(true));
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  const symbol = source && checker.getSymbolAtLocation(source);
  return symbol ? checker.getExportsOfModule(symbol).map(exported => exported.name).sort() : [];
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'wherelive-package-'));
  installed = join(workspace, 'app/node_modules/wherelive');
  mkdirSync(installed, { recursive: true });
  await build({ config: join(root, 'tsup.config.ts'), outDir: join(installed, 'dist'), sourcemap: false, silent: true });
  cpSync(join(root, 'package.json'), join(installed, 'package.json'));
  writeFileSync(join(workspace, 'app/use.ts'), consumer);
}, 180_000);

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe('the published package', () => {
  it('has a file for every entry point that package.json promises', () => {
    const targets: string[] = [];
    for (const conditions of Object.values(pkg.exports)) {
      for (const kind of Object.values(conditions as Record<string, Record<string, string>>)) targets.push(...Object.values(kind));
    }
    expect(targets.length).toBeGreaterThan(10);
    for (const target of targets) expect(existsSync(join(installed, target)), target).toBe(true);
  });

  it('exports exactly the names that are meant to be public', () => {
    expect(exportsOf('index.d.ts')).toEqual(MAIN);
    expect(exportsOf('transport.d.ts')).toEqual(TRANSPORT);
  });

  it('keeps the transport names out of the main entry, and the main names out of the transport entry', () => {
    expect(MAIN.filter(name => TRANSPORT.includes(name))).toEqual([]);
  });
});

describe.each([
  ['strict', true],
  ['not strict, as an app with strict off compiles it', false],
])('a consumer with declaration: true, %s', (_label, strict) => {
  it('compiles, and every inferred type can be written into its declarations', () => {
    const { problems } = compileConsumer(strict);
    expect(problems).toEqual([]);
  }, 120_000);

  it('names our types through the package, never through an internal file', () => {
    const { declaration } = compileConsumer(strict);
    const specifiers = new Set([...declaration.matchAll(/(?:from |import\()['"]([^'"]+)['"]/g)].map(match => match[1]));
    expect([...specifiers].sort()).toEqual(['wherelive', 'wherelive/transport'].filter(name => specifiers.has(name)));
    expect(specifiers.has('wherelive')).toBe(true);
    expect(declaration).not.toMatch(/dist\//);
  }, 120_000);
});
