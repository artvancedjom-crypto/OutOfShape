// Runs the end-to-end tests in tests/e2e against a temporary dev server.
//   npm run test:e2e              all tests
//   npm run test:e2e -- 03 05     only files whose name contains "03" or "05"
// Needs Playwright with Chromium (not a project dependency):
//   npm i -D playwright && npx playwright install chromium
import { createServer } from 'vite';
import { spawn, execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.slice(2);
const files = readdirSync(join(root, 'tests', 'e2e')).filter((f) => f.endsWith('.cjs') && (!only.length || only.some((o) => f.includes(o)))).sort();

const server = await createServer({ root, server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
// a globally installed Playwright is fine too
let globalModules = '';
try { globalModules = execSync('npm root -g', { encoding: 'utf8' }).trim(); } catch { /* ignore */ }
const env = { ...process.env, E2E_BASE: 'http://localhost:5199/', NODE_PATH: [join(root, 'node_modules'), globalModules, process.env.NODE_PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':') };

let failed = 0;
for (const f of files) {
  console.log(`\n\x1b[36m▶ ${f}\x1b[0m`);
  // asynchronous on purpose: the dev server lives in this process and must keep answering
  const code = await new Promise((resolve) => spawn(process.execPath, [join(root, 'tests', 'e2e', f)], { stdio: 'inherit', env }).on('exit', resolve));
  if (code !== 0) { failed++; console.log(`\x1b[31m✗ ${f} failed\x1b[0m`); }
}
await server.close();
console.log(failed ? `\n${failed} of ${files.length} end-to-end test files failed.` : `\nAll ${files.length} end-to-end test files passed.`);
process.exit(failed ? 1 : 0);
