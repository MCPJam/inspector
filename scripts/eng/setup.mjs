/**
 * Whether each host's hooks are running. A host that skips hooks says
 * nothing, so every hook run records the hash of the config it ran from,
 * and `eng hooks` compares that with the config on disk. Codex skips a
 * changed hook until someone trusts it again; this is how that shows up.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { now } from './effort.mjs';
import { read, write } from './state.mjs';

export const HOST_CONFIG = {
  claude: '.claude/settings.json',
  codex: '.codex/hooks.json',
  cursor: '.cursor/hooks.json',
};

const TRUST = {
  claude:
    'Claude Code runs them from .claude/settings.json; review them with /hooks.',
  codex:
    'Codex runs them only in a trusted project and skips any changed hook until you trust it again with /hooks.',
  cursor:
    'Cursor runs them only in a trusted workspace. Cursor CLI is not supported.',
};

export function configHash(root, host) {
  try {
    const text = readFileSync(join(root, HOST_CONFIG[host]));
    return createHash('sha256').update(text).digest('hex').slice(0, 12);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function noteHostRun(co, host) {
  write(co.dir, `hosts/${host}.json`, {
    seenAt: now(),
    configHash: configHash(co.root, host),
  });
}

/** One line per host: running on the current config, stale, or never seen. */
export function hostStatus(co) {
  return Object.keys(HOST_CONFIG).map((host) => {
    const seen = read(co.dir, `hosts/${host}.json`);
    const current = configHash(co.root, host);
    if (!current) return `${host}: no ${HOST_CONFIG[host]} in this checkout.`;
    if (!seen) {
      return `${host}: hooks have not run in this checkout. ${TRUST[host]}`;
    }
    if (seen.configHash !== current) {
      return `${host}: hooks last ran at ${seen.seenAt} from an older ${HOST_CONFIG[host]}. ${TRUST[host]}`;
    }
    return `${host}: hooks running (last ${seen.seenAt}).`;
  });
}
