import {spawnSync} from 'node:child_process';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const mode = process.argv[2] ?? process.env.npm_lifecycle_event;

// CMD cannot use a UNC working directory; pushd maps it to a temporary drive.
if (process.platform === 'win32' && projectRoot.startsWith('\\')) {
  const command = `pushd ${projectRoot} && node scripts\\run.mjs ${mode}`;
  const result = spawnSync('cmd.exe', ['/d', '/c', command], {stdio: 'inherit'});
  process.exit(result.status ?? 1);
}
process.chdir(projectRoot);
if (mode !== 'preview' && mode !== 'test') await import('./prepare-data.mjs');
if (mode === 'data') process.exit(0);

if (mode === 'dev' && process.platform === 'win32') {
  const vite = path.resolve(import.meta.dirname, '../node_modules/vite/bin/vite.js');
  const build = spawnSync(process.execPath, [vite, 'build'], {stdio: 'inherit'});
  if (build.status !== 0) process.exit(build.status ?? 1);
  console.log('Windows/WSL mode: serving the built demo at http://127.0.0.1:5173/');
  await import('./serve.mjs');
} else {
  const args = mode === 'build' ? ['build'] : mode === 'preview' ? ['preview', '--host', '127.0.0.1'] : ['--host', '127.0.0.1'];
  const entry = mode === 'test' ? '../node_modules/@playwright/test/cli.js' : '../node_modules/vite/bin/vite.js';
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, entry), ...(mode === 'test' ? ['test'] : args)], {stdio: 'inherit'});
  process.exit(result.status ?? 1);
}
