import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  banner: {
    js: '#!/usr/bin/env node',
  },
  clean: true,
  sourcemap: false,
  minify: false,
  splitting: false,
  shims: true,
});
