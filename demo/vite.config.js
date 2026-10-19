import {defineConfig} from 'vite';
export default defineConfig({server:{host:'127.0.0.1',watch:{usePolling:process.platform==='win32'}},preview:{host:'127.0.0.1'}});
