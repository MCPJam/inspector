#!/usr/bin/env node
/**
 * The deterministic gate between Claude's edit and a pull request in the
 * nightly deletion bot. Whatever the model did, only a change of the declared
 * shape is pushed:
 *
 *   dead-files:       only whole-file deletions, nothing added or modified.
 *   history-comments: the code with comments removed is unchanged, and there
 *                     are fewer history comments than before.
 *
 * Both: at most MAX_LINES changed lines, and no ratchet rule goes up.
 *
 *   node scripts/slop/deletion-bot-check.mjs --lane dead-files
 *
 * Exit 0 with "nothing to do" when the tree is clean, 0 when the change is
 * valid, 1 otherwise. Prints the changed paths, one per line, on success.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { compare } from "./ratchet.mjs";

export const MAX_LINES = 400;

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** `git status --porcelain` entries, untracked included. */
function changes() {
  return git(["status", "--porcelain", "--untracked-files=all", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((entry) => ({
      status: entry.slice(0, 2).trim(),
      path: entry.slice(3),
    }));
}

/**
 * The code in `text` with comments removed and whitespace normalized: trimmed
 * lines, runs of spaces collapsed, blank lines dropped. Strings and template
 * literals are skipped so a `//` inside one is not read as a comment.
 */
export function codeOnly(text) {
  // Literals are set aside and replaced by a numbered marker, so the
  // whitespace normalization below cannot reach inside them.
  const literals = [];
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
      out += " ";
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      literals.push(text.slice(i, j + 1));
      out += `\u0000${literals.length - 1}\u0000`;
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n")
    .replace(/\u0000(\d+)\u0000/g, (_, index) => literals[Number(index)]);
}

export function checkLane(lane, entries, { before, after, linesOf }) {
  const problems = [];
  let total = 0;
  for (const { status, path } of entries) {
    if (lane === "dead-files") {
      if (status !== "D")
        problems.push(`${path}: ${status}, only deletions allowed`);
    } else if (lane === "history-comments") {
      if (status !== "M") {
        problems.push(
          `${path}: ${status}, only edits to existing files allowed`
        );
      } else {
        if (codeOnly(before(path)) !== codeOnly(after(path))) {
          problems.push(`${path}: code changed, not only comments`);
        }
      }
    } else {
      problems.push(`unknown lane ${lane}`);
      break;
    }
    total += linesOf(path);
  }
  if (total > MAX_LINES) {
    problems.push(`${total} changed lines, over the ${MAX_LINES}-line budget`);
  }
  return { problems, total };
}

// Compared as URLs: on Windows argv[1] is a `C:\` path, not a `file:` URL.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf("--lane");
  const lane = index === -1 ? "" : process.argv[index + 1];
  const entries = changes();
  if (!entries.length) {
    console.error("nothing to do: the tree is clean");
    process.exit(0);
  }
  const { problems } = checkLane(lane, entries, {
    before: (path) => git(["show", `HEAD:${path}`]),
    after: (path) => readFileSync(path, "utf8"),
    linesOf: (path) =>
      git(["diff", "--numstat", "HEAD", "--", path])
        .split("\n")
        .filter(Boolean)
        .reduce((sum, row) => {
          const [added, deleted] = row.split("\t");
          return sum + (Number(added) || 0) + (Number(deleted) || 0);
        }, 0),
  });

  const { deltas } = compare("HEAD");
  for (const [rule, delta] of Object.entries(deltas)) {
    if (delta > 0) problems.push(`ratchet rule ${rule} went up by ${delta}`);
  }
  if (lane === "history-comments" && !(deltas["history-comment"] < 0)) {
    problems.push("no history comment was removed");
  }

  if (problems.length) {
    console.error(`Refusing to open a PR for lane ${lane}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  for (const { path } of entries) console.log(path);
}
