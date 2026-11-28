import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function sourceRevision(checkout) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: checkout, maxBuffer: 64 * 1024 * 1024 });
  const commit = git("rev-parse", "HEAD").toString().trim();
  const changes = git("diff", "--binary", "HEAD", "--");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z")
    .toString().split("\0").filter(Boolean).sort();
  if (!changes.length && !untracked.length) return { commit, snapshot: commit };

  const digest = createHash("sha256").update(commit).update(changes);
  for (const path of untracked) {
    const bytes = readFileSync(join(checkout, path));
    digest.update(JSON.stringify([path, bytes.length])).update(bytes);
  }
  return { commit, snapshot: digest.digest("hex") };
}
