import {spawnSync} from 'node:child_process';
import path from 'node:path';
const mode=process.argv[2];
if(mode!=='preview' && mode!=='test')await import('./prepare-data.mjs');
const args=mode==='build'?['build']:mode==='preview'?['preview','--host','127.0.0.1']:['--host','127.0.0.1'];
const entry=mode==='test'?'../node_modules/@playwright/test/cli.js':'../node_modules/vite/bin/vite.js';
const result=spawnSync(process.execPath,[path.resolve(import.meta.dirname,entry),...(mode==='test'?['test']:args)],{stdio:'inherit'});
process.exit(result.status??1);
