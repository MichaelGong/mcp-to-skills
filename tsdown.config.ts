import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  target: 'node20',
  // Keep `.js` / `.d.ts` so package.json `main` / `bin` / `types` (and any
  // `npm i -g` consumers) work without changes.
  fixedExtension: false,
  outputOptions: {
    entryFileNames: '[name].js',
    chunkFileNames: 'shared/[name]-[hash].js',
  },
})
