import { build } from 'esbuild';

await build({
  entryPoints: ['src/client/app.js'],
  bundle: true,
  format: 'esm',
  target: ['es2020', 'chrome90', 'firefox90', 'safari15'],
  minify: true,
  sourcemap: process.env.SOURCEMAP === '1',
  outfile: 'public/assets/app.js',
  logLevel: 'info',
});
