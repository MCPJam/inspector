import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * The action's own version tags, `evals-v1.MINOR.PATCH`.
 *
 * The major is fixed by the floating tag's name: everyone pinned to `evals-v1`
 * follows this family, so a breaking change means a new `evals-v2` family and a
 * new floating tag, never a major bump inside this one.
 */
const VERSION_TAG = /^evals-v1\.(\d+)\.(\d+)$/;

function parse(tag) {
  const match = VERSION_TAG.exec(tag.trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** The highest version tag in the list, or `null` when it holds none. */
export function highestVersionTag(tags) {
  let best = null;
  for (const tag of tags) {
    const version = parse(tag);
    // Compared as NUMBERS, not as strings: `evals-v1.0.10` sorts below
    // `evals-v1.0.9` lexicographically, which would reissue a published tag.
    if (
      version &&
      (!best ||
        version[0] > best[0] ||
        (version[0] === best[0] && version[1] > best[1]))
    ) {
      best = version;
    }
  }
  return best ? `evals-v1.${best[0]}.${best[1]}` : null;
}

/** The next patch tag after everything published so far. */
export function nextVersionTag(tags) {
  const highest = parse(highestVersionTag(tags) ?? "");
  return highest ? `evals-v1.${highest[0]}.${highest[1] + 1}` : "evals-v1.0.0";
}

/**
 * The tag this release should publish.
 *
 * A commit that already carries a version tag keeps it. That is what makes a
 * re-run after a partial failure — the immutable tag pushed, the floating tag
 * not yet moved — finish the job instead of minting a second tag for bytes
 * that were already published.
 */
export function chooseVersionTag(tags, tagsAtCommit) {
  return highestVersionTag(tagsAtCommit) ?? nextVersionTag(tags);
}

function gitTags(args) {
  return execFileSync("git", ["tag", "-l", "evals-v1.*", ...args], {
    encoding: "utf8",
  }).split("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = process.argv[2];
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) {
    process.stderr.write("A full commit SHA is required.\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `${chooseVersionTag(gitTags([]), gitTags(["--points-at", sha]))}\n`,
    );
  }
}
