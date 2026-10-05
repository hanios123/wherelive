import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    transport: 'src/transport.ts',
    firebase: 'src/firebase/index.ts',
    rxjs: 'src/rxjs/index.ts',
    testing: 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2020',
  external: ['firebase', 'rxjs'],
});
