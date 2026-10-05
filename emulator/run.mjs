// Starts the Firestore and Realtime Database emulators, runs the tests in test-emulator/ against them, and stops them.
// Needs Java 11 or newer and the Firebase CLI (`npm install -g firebase-tools`). The project id starts with `demo-`,
// which keeps the emulators from ever touching a real project and needs no login.
import { spawnSync } from 'node:child_process';

const missing = (command, args) => spawnSync(command, args, { stdio: 'ignore' }).status !== 0;
if (missing('java', ['-version'])) {
  console.error('The emulators need Java 11 or newer, and `java` was not found.');
  process.exit(1);
}
if (missing('firebase', ['--version'])) {
  console.error('The Firebase CLI was not found. Install it with `npm install -g firebase-tools`.');
  process.exit(1);
}

const extra = process.argv.slice(2).filter(arg => arg !== '--');
const command = ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.emulator.config.ts', ...extra].join(' ');
const run = spawnSync('firebase', ['emulators:exec', '--only', 'firestore,database', '--project', 'demo-wherelive', command], { stdio: 'inherit' });
process.exit(run.status ?? 1);
