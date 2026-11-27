// Dev gateway on 20480/20481 for `pnpm dev` / `pnpm serve` (same ports as e2e). Loads the repo-root
// `.env` when present so `ANTIRION_BOOTSTRAP_TOKEN` matches what you paste at sign-in.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i <= 0) continue;
    const key = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
// Cookie-session writes from `pnpm dev` use this origin (see ci/standalone.yaml).
if (!process.env.ANTIRION_PUBLIC_ORIGIN) {
  process.env.ANTIRION_PUBLIC_ORIGIN = 'http://localhost:3001';
}

const consoleDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [join(consoleDir, 'tests/e2e/start-gateway.mjs')], {
  stdio: 'inherit',
  env: process.env,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));