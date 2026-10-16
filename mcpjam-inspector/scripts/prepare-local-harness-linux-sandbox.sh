#!/usr/bin/env bash
set -euo pipefail

# Ubuntu restricts capabilities in unprivileged user namespaces. Use its
# bwrap-specific profile: the helper can set up the namespace, while its
# children remain capability-denied. Do not disable the host policy globally.
sudo apt-get update
sudo apt-get install -y --no-install-recommends bubblewrap apparmor-profiles
profile=/usr/share/apparmor/extra-profiles/bwrap-userns-restrict
restriction=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
if [[ -f "$restriction" && "$(< "$restriction")" == 1 ]]; then
  sudo apparmor_parser -r "$profile"
fi

# The actual sandbox probe runs as the ordinary CI user, without sudo.
/usr/bin/bwrap --unshare-user --unshare-net --ro-bind / / --proc /proc --dev /dev -- /bin/true

node --input-type=module - "$1" <<'NODE'
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const out = process.argv[2];
const profile = '/usr/share/apparmor/extra-profiles/bwrap-userns-restrict';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  prerequisite: 'linux-codex-command-sandbox',
  kernel: execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim(),
  bubblewrap: execFileSync('/usr/bin/bwrap', ['--version'], { encoding: 'utf8' }).trim(),
  bubblewrapSha256: createHash('sha256').update(readFileSync('/usr/bin/bwrap')).digest('hex'),
  profileSha256: createHash('sha256').update(readFileSync(profile)).digest('hex'),
  unprivilegedNamespaceProbe: 'passed',
}, null, 2) + '\n');
NODE
