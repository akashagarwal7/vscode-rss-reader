import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
if (existsSync('node_modules/@vscode/codicons/dist')) {
  for (const f of ['codicon.css', 'codicon.ttf']) {
    copyFileSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/${f}`);
  }
}

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const configs = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
];
if (existsSync('src/webview/main.ts')) {
  configs.push({
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  });
}

const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
