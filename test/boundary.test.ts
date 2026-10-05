import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(__dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** Everything except the folders that exist to touch the outside world: the SDK adapters, the RxJS bridge and the test transports. */
const engine = files(src).filter(path => !/^(firebase|rxjs|testing)\//.test(relative(src, path)));

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the core has no framework, Firebase SDK or browser dependency', () => {
  it('finds the engine files', () => {
    expect(engine.map(path => relative(src, path))).toEqual(
      expect.arrayContaining(['core/list-query.ts', 'schema/schema.ts', 'listen/registry.ts', 'realtime/backend.ts', 'firestore/backend.ts']),
    );
  });

  const forbiddenModules = /from\s+['"](firebase|@firebase|react|react-dom|vue|@vue|@angular|svelte|rxjs|zone\.js)[^'"]*['"]/;
  const forbiddenGlobals = /\b(window|document|localStorage|sessionStorage|navigator|process|Buffer|require)\b/;

  it.each(engine.map(path => [relative(src, path), stripComments(readFileSync(path, 'utf8'))] as const))(
    '%s imports no framework or SDK and touches no browser or Node global',
    (_name, code) => {
      expect(code).not.toMatch(forbiddenModules);
      expect(code).not.toMatch(forbiddenGlobals);
    },
  );

  it('does no work at import time that needs a browser', async () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    const library = await import('../src');
    expect(Object.keys(library)).toEqual(
      expect.arrayContaining(['ListQuery', 'schema', 'leaf', 'realtimeBackend', 'firestoreBackend', 'ListenError']),
    );
  });

  it('the public entry point does not re-export the SDK adapters', async () => {
    const library = await import('../src');
    expect(Object.keys(library).filter(name => /^firebase/i.test(name))).toEqual([]);
  });
});
