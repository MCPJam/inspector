import { readFileSync, appendFileSync } from 'node:fs';
const pins = JSON.parse(readFileSync(new URL('./local-harness-toolchain.json', import.meta.url), 'utf8'));
for (const name of ['node', 'pnpm', 'go']) {
  if (!/^\d+\.\d+\.\d+$/.test(pins[name])) throw new Error(`Invalid ${name} pin`);
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(pins).map(([k,v]) => `${k}=${v}\n`).join(''));
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `BUNDLED_NODE_VERSION=${pins.node}\n`);
