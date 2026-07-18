import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  // A CLI binary ships without its original TypeScript source, so a
  // source map can't resolve back to anything meaningful for an end
  // user - it only adds ~3x the download size (a ~225KB map next to the
  // ~70KB bundle) to every `npx`/`npm install` for no practical benefit.
  sourcemap: false,
  minify: false,
  splitting: false,
  shims: false,
  banner: { js: '#!/usr/bin/env node' },
});
