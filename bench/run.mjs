// Runs the benchmark groups one after another, each in its own process so that one group's compiled code
// cannot change how the next one runs.
//
//   pnpm bench                 query, project, live
//   pnpm bench query live      only those groups
//   pnpm bench -- --quick      1,000 and 10,000 rows only (about a third of the time)
//   pnpm bench diagnose        one-variable experiments that explain the numbers
//
// SIZES=1000,10000 chooses the row counts. BENCH_RESULTS=file.jsonl also writes every result as a line of JSON.
import { execSync, spawnSync } from 'node:child_process';
import os from 'node:os';

const groups = {
  query: 'filter, sort, top-k, early exit, per-query fixed cost',
  project: 'select, distinct, group by, join, union, flatMap',
  live: 'live lists, fan-out, listen/stop, replay, memory, get()',
  diagnose: 'string path vs function, count with select, limit vs sort',
};
const defaults = ['query', 'project', 'live'];

const args = process.argv.slice(2).filter(arg => arg !== '--');
const quick = args.includes('--quick');
const wanted = args.filter(arg => !arg.startsWith('--'));
const unknown = wanted.filter(name => !(name in groups));
if (unknown.length > 0) {
  console.error(`Unknown group: ${unknown.join(', ')}. Groups: ${Object.keys(groups).join(', ')}.`);
  process.exit(1);
}

console.log(`wherelive benchmarks  |  node ${process.version}  |  ${os.cpus()[0]?.model ?? 'unknown cpu'}  |  ${os.cpus().length} cores`);
if (process.platform === 'darwin') {
  try {
    if (execSync('pmset -g batt', { encoding: 'utf8' }).includes('Battery Power')) {
      console.log('NOTE: this machine is on battery power. It may run slower and less steadily; plug in for numbers you compare across runs.');
    }
  } catch {
    // no power information: nothing to warn about
  }
}

const env = { ...process.env, ...(quick && !process.env.SIZES ? { SIZES: '1000,10000' } : {}) };
for (const name of wanted.length > 0 ? wanted : defaults) {
  console.log(`\n##### ${name}: ${groups[name]}`);
  const run = spawnSync(process.execPath, ['--expose-gc', new URL(`./${name}.mjs`, import.meta.url).pathname], { stdio: 'inherit', env });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
