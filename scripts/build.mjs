import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/renderer.js'],
  outfile: 'dist/renderer.js',
  bundle: true,
  format: 'esm',
  target: 'chrome138',
  minify: true,
  loader: { '.css': 'text' },
  legalComments: 'eof',
});
await Promise.all(['main.cjs', 'preload.cjs'].map(file => copyFile(`src/${file}`, `dist/${file}`)));
