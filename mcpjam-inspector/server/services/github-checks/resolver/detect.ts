/**
 * Rung 2: detection — guess how to build and start the server from the SHAPE
 * of the checkout.
 *
 * This rung is HEURISTIC (see types.ts): nobody promised us anything, so it
 * never throws. It returns zero or more candidates, ordered best-first, and
 * the orchestrator (R4) tries them one at a time — each in its own sandbox —
 * until one builds and speaks MCP.
 *
 * THE ONE INVARIANT THAT MAKES THIS SAFE TO RUN:
 *
 *   A candidate must RUN THE CHECKOUT.
 *
 * A check exists to say whether THIS PULL REQUEST works. A command like
 * `npx @acme/mcp-server` or `node https://…` looks like it starts the server
 * and would even go green, but it starts the PUBLISHED artifact — the check
 * would then report on code the PR never touched, which is worse than no check
 * at all (a silent false green on a broken PR). So anything that resolves to a
 * published package or a remote URL is DISCARDED, with the reason recorded, and
 * we would rather emit no candidate than a lying one. The same applies one step
 * closer to home: a command that starts an INSTALLED DEPENDENCY
 * (`node node_modules/@acme/server/bin.js`) or reaches outside the checkout
 * (`../`) is published code too, and is discarded for the same reason.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE POLICY IS AN ALLOWLIST, NOT A BLOCKLIST. THIS IS THE IMPORTANT PART.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module used to enumerate KNOWN-BAD launcher spellings and let everything
 * else through. That approach sprang a leak in three consecutive review rounds,
 * each a different spelling of the same bypass:
 *
 *   1. `npm --yes exec -- @acme/mcp-server` — an option between `npm` and
 *      `exec` walked past an adjacency-based regex;
 *   2. `node "$(npm root)"/@acme/server/bin.js` — the entry path is computed by
 *      the SHELL at runtime, so no literal-path check can ever see it;
 *   3. `[project.scripts] acme = "fastmcp.cli:main"` — `module:attr` is a
 *      SYNTAX, and syntax proves nothing about who owns the module; `uv run
 *      acme` then starts the dependency.
 *
 * A blocklist cannot establish the invariant we actually need, because the
 * invariant is a positive claim: THIS COMMAND DEMONSTRABLY RUNS CODE FROM THE
 * PR CHECKOUT. Patching spellings only ever proves a command is not one of the
 * launchers we happened to think of. So the policy is inverted: a heuristic
 * candidate is emitted only when it is PROVABLY local, and SUPPRESSED whenever
 * we cannot establish that — including when the reason we cannot is simply that
 * we lack the evidence.
 *
 * The asymmetry is what licenses being this aggressive:
 *
 *   suppressed candidate  →  a resolver MISS. Neutral check, measurable in the
 *                            corpus, and recoverable by the author in one file
 *                            (`mcpjam.yaml`, the authoritative rung).
 *   accepted-but-wrong    →  a SILENT FALSE GREEN on published code. Nobody
 *                            finds out, and it is the exact failure this module
 *                            exists to prevent.
 *
 * A miss costs recall. A false green costs the product its meaning. We buy the
 * second with the first, deliberately, and the corpus harness reports the price.
 *
 * The three rules that implement the inversion:
 *
 *   A. UNPROVABLE BY CONSTRUCTION → REJECT. A start command containing shell
 *      metacharacters ($, backtick, |, ;, &, <, >, globs, braces, subshells,
 *      newlines) computes its own entry point at runtime. No static analysis
 *      can see what it runs, so nothing about it can be proven, so it is never
 *      emitted. This kills finding 2 and its whole class permanently, rather
 *      than one spelling of it.
 *   B. FETCHING SUBCOMMAND ANYWHERE IN THE TOKEN LIST → REJECT. Launcher
 *      detection is TOKEN-based, not adjacency-based: `npm … exec` is a fetch
 *      no matter how many options are interleaved. This kills finding 1 and
 *      every option permutation of it.
 *   C. ENTRY POINTS ARE VERIFIED AGAINST THE ACTUAL CHECKOUT when a file
 *      listing is available (`DetectionInputs.repoFiles`). For python, that
 *      verification is REQUIRED — without it, a `[project.scripts]` target is
 *      suppressed outright, which is finding 3's answer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RULE C, ROUND 2: WHAT COUNTS AS EVIDENCE (and what only LOOKED like it)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The first cut of rule C accepted on evidence that does not actually establish
 * ownership. Four more spellings of the same mistake, and the answer each got:
 *
 *   a. "A build script exists, so an absent `dist/index.js` must be built from
 *      the checkout." It must not. `"build": "mkdir -p dist && cp
 *      node_modules/acme/server.js dist/index.js"` copies PUBLISHED code into
 *      that exact path. A build step runs arbitrary code, so its OUTPUT has no
 *      statically knowable provenance. The inference is gone — see below for
 *      what replaces it.
 *   b. "The path is in `git ls-files`, so it is checkout source." `git ls-files`
 *      yields PATHS, not file TYPES. A tracked `server.js` that is a SYMLINK to
 *      `node_modules/acme/server.js` (or to `../outside`) appears in that
 *      listing as an innocuous relative path, and node follows the link. So
 *      `repoFiles` now carries a kind per entry, and a symlinked entry point is
 *      SUPPRESSED — we do not chase the target and reason about it, because
 *      unresolvable provenance is a miss, and a miss is recoverable.
 *   c. "Every entry point is checked." Only tokens with a script EXTENSION were
 *      ever extracted, so `"start": "start-server"` — a bare word resolved out
 *      of `node_modules/.bin` — extracted ZERO entry paths and sailed past a
 *      rule that never fired. That is the node twin of finding 3, and it is now
 *      suppressed whenever a listing is available.
 *   d. "A relative path can only resolve inside the checkout." True, but the
 *      code never required the path to BE relative: `node /etc/foo.js` and
 *      `node C:/x.js` passed. Relativity is now mandatory at every acceptance
 *      site, including the build-output one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RULE C, ROUND 3: `scripts.start` IS NOT THE ONLY THING `npm start` RUNS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Rounds 1 and 2 both analysed the LITERAL BODY of `scripts.start` and assumed
 * that was the whole of what the emitted command executes. It is not. npm (and
 * pnpm/yarn/bun) resolve two further layers that the body never mentions:
 *
 *   1. LIFECYCLE HOOKS. `npm start` runs `prestart`, then `start`, then
 *      `poststart`. A `prestart` of `npx @acme/server` launches a published
 *      package while `scripts.start` sits there looking impeccable. Nothing in
 *      round 2 ever read `prestart`. And the hooks are not special to `start`:
 *      npm fires `pre<name>`/`post<name>` for ARBITRARY script names, so they
 *      exist at every level of indirection too (round 3.1's finding).
 *   2. SCRIPT INDIRECTION. `"start": "npm run serve"` runs `scripts.serve`,
 *      which round 2 also never read. Round 2's answer was to DISCARD every
 *      indirection wholesale — safe, but it cost real repos (exa-mcp-server's
 *      `"start": "npm run dev"` was a corpus miss for exactly this reason), and
 *      it only covered the plain `npm run X` spelling. `pnpm serve`,
 *      `yarn serve`, `bun run serve` and `npm-run-all a b` are the same
 *      indirection in different clothes.
 *
 * The prescription is the same inversion as before, applied one level deeper:
 * do not blacklist the spellings of indirection, RESOLVE it and verify what it
 * lands on. So a script reference is followed through the `scripts` map and the
 * full rule set is applied to the resolved body, recursively, with a depth cap
 * (MAX_SCRIPT_DEPTH) and cycle detection. Anything that cannot be resolved —
 * an absent script, a computed script name, an unrecognised runner, a cycle,
 * a chain deeper than the cap — is SUPPRESSED, with its own reason. That turns
 * a blanket discard into "verify and accept when provable", which recovers
 * legitimate repos without conceding anything to the unprovable ones.
 *
 * WHICH HOOKS ARE ACCOUNTED FOR, AND WHY THE OTHERS ARE NOT. The surface is
 * decided by the two commands this module actually emits — `<pm> start` and
 * `<install> [&& <pm> run build]` — and by which of them can put a process
 * behind the PROBE, because that is the only way a false GREEN happens:
 *
 *   START LIFECYCLE — `prestart`, `start`, `poststart`, AND the `pre`/`post`
 *     hooks of every script reached from them.  FULLY IN SCOPE.
 *     `start` gets rules A + B + escape + C, recursively: it is the process the
 *     probe talks to, so its ownership is the invariant.
 *     `prestart`/`poststart` get rules A + B, recursively, but NOT rule C and
 *     not the escapes-checkout check. This is a deliberate line, not an
 *     oversight: a hook must EXIT
 *     before npm moves on, so it cannot be the process the probe connects to.
 *     A `prestart` that foregrounds a published server hangs npm and the check
 *     times out — a red result with honest blame, not a false green. A hook
 *     that DETACHES one is the real hazard, and rule A already refuses `&`,
 *     backgrounding and chaining in the start lifecycle. Applying rule C here
 *     would instead suppress `"prestart": "tsc"` — a build tool, doing exactly
 *     its job — and buy no safety for it.
 *
 *   BUILD LIFECYCLE — `prebuild`, `build`, `postbuild`, and the scripts they
 *     REFERENCE.  RULE B ONLY.
 *     This extends the check `build` already had to the hooks `npm run build`
 *     drags along with it, and follows statically resolvable script references
 *     so `"build": "npm run bundle"` cannot park the fetch one hop away. Rules
 *     A and C are deliberately not applied, and an UNRESOLVABLE reference is
 *     deliberately not a rejection: build steps chain and expand freely by
 *     design (see UNPROVABLE_SHELL_RE), and a build that misbehaves yields
 *     `build_failed`, which is honest.
 *
 *   INSTALL LIFECYCLE — `preinstall`, `install`, `postinstall`, `prepublish`,
 *     `preprepare`, `prepare`, `postprepare` (npm 11.x's documented order for
 *     `install`/`ci`).  NARROW RULE: detach AND foreign.
 *     These run for any `npm ci`/`npm install`, so we cannot avoid triggering
 *     them and a broad rule here would suppress half the ecosystem
 *     (`patch-package`, `husky`, `npx playwright install`). A FOREGROUND launch
 *     in an install hook cannot produce a false green — it either exits, or it
 *     hangs and the build times out. The shapes that can are a hook that
 *     BACKGROUNDS something foreign: either a fetch (`nohup npx @acme/server
 *     &`) or a binary npm itself put on PATH from `node_modules/.bin`
 *     (`nohup acme-mcp-server &` — no fetch at all, and just as capable of
 *     answering the probe with published code). That conjunction, and only that
 *     conjunction, suppresses the candidate.
 *
 *   OUT OF SCOPE BY CONSTRUCTION — `prepublishOnly`, `prepack`, `postpack`,
 *     `pretest`/`test`/`posttest`, `preversion`, `publish`. None of them run
 *     for `npm ci`, `npm install`, `npm run build` or `npm start`, so nothing
 *     we emit can trigger them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT REPLACES THE BUILD-SCRIPT INFERENCE: `ownershipProof`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dropping build outputs entirely would collapse recall — build outputs are by
 * definition not committed, and `node dist/index.js` after `npm run build` is
 * the single most common shape in the ecosystem. So they are still emitted, but
 * they are no longer PRETENDING to be proven: every candidate carries
 * `ownershipProof: 'verified' | 'unverified'` (see ./types.ts).
 *
 *   'verified'   — the entry point is a regular file in the checkout listing.
 *   'unverified' — accepted but unproven: a relative, non-escaping path that no
 *                  listing contains and a build step plausibly produces; or the
 *                  degenerate case where no listing was supplied at all, so
 *                  there was nothing to verify against.
 *
 * The plan was for A3 to SETTLE 'unverified' at runtime, by resolving the
 * listening process's main module out of `/proc`. That was built and then
 * removed — `/proc/<pid>/cmdline` cannot say which argument is the program, so
 * the rule rejected ordinary `tsx`/`uv` servers and still missed the case it
 * was for. See the box in ./types.ts. The label therefore stays a label: it
 * records that the rules below accepted a path on plausibility rather than on
 * evidence, and the runtime check A3 does run is LISTENER IDENTITY, which
 * answers a different (and answerable) question.
 *
 * v1 ECOSYSTEMS (deliberately short; everything else yields no candidate):
 *   - node: npm (package-lock.json), pnpm (pnpm-lock.yaml), yarn classic
 *     (yarn.lock), driven off package.json
 *   - python: pyproject.toml + uv.lock (uv only)
 * bun / poetry / pipenv / go / rust are out of scope for v1 — they are named
 * in the discard reasons so the corpus report can count them honestly rather
 * than burying them in one "unsupported" bucket.
 *
 * NO I/O: like mcpjamYaml.ts, this module is a pure function of already-read
 * file contents. The worker does the (byte-capped, in-sandbox) reading.
 */

import type { CheckRecipe } from "../recipes";
import type { OwnershipProof, ResolvedRecipe } from "./types";

/**
 * One entry of the checkout listing.
 *
 * The KIND is the load-bearing half, and it is why this is not `string[]` any
 * more. `git ls-files` prints paths; a tracked `server.js` that is a symlink to
 * `node_modules/acme/server.js` prints as `server.js` and looks exactly like
 * checkout source. Node follows the link. So callers must say what each entry
 * IS, and only `'file'` — a regular file — can prove ownership.
 *
 *   'file'    — regular file (git mode 100644 / 100755).
 *   'symlink' — git mode 120000. SUPPRESSED as an entry point: we deliberately
 *               do not resolve the target and reason about it, because a
 *               symlink is precisely the case where the path text lies.
 *   'other'   — submodule (160000), gitlink, or anything a caller cannot
 *               classify. Treated like 'symlink': not proof of anything.
 */
export type RepoFileKind = "file" | "symlink" | "other";

export type RepoFileEntry = { path: string; kind: RepoFileKind };

/**
 * Contents of the files detection looks at; `null` means "file absent", which
 * is itself a signal (a missing lockfile changes the install command). The
 * field list is fixed and ordered because R3 hashes exactly these paths to key
 * the recipe cache — adding one here is a cache-key change, not a local edit.
 */
export type DetectionInputs = {
  packageJson: string | null;
  packageLockJson: string | null;
  pnpmLockYaml: string | null;
  yarnLock: string | null;
  pyprojectToml: string | null;
  uvLock: string | null;
  /** Registry manifest (modelcontextprotocol/registry). HINTS ONLY. */
  serverJson: string | null;
  /** README.md. HINTS ONLY. */
  readme: string | null;
  /**
   * OPTIONAL, and the evidence that turns rule C from a guess into a proof:
   * the checkout's files as relative paths (POSIX separators, no leading `./`)
   * PAIRED WITH THEIR TYPE. This is a FILE LISTING, not file contents — it does
   * not join the R3 recipe cache key the way the parsed fields above do,
   * because it is derived from the same commit those are read at.
   *
   * The type is not decoration. A path-only listing cannot distinguish a
   * regular `server.js` from a symlink into `node_modules/`, and the second one
   * runs published code while looking identical in the text. Only
   * `kind: 'file'` proves ownership; anything else suppresses the candidate.
   *
   * When ABSENT, node falls back to the strict syntactic path rules (relative,
   * no `node_modules`, no `../`, safe charset) and marks the result
   * `ownershipProof: 'unverified'`, and python `[project.scripts]` candidates
   * are suppressed outright — see `detectPython`.
   *
   * Populated today by `scripts/resolver-corpus.ts` (it has the clone on disk,
   * and reads modes out of `git ls-files -s`). A3 populates it from the
   * sandbox, where the checkout is likewise on disk; until then, production
   * callers pass nothing and get the conservative path.
   */
  repoFiles?: RepoFileEntry[];
};

/**
 * Defensive cap in BYTES for files we PARSE, mirroring
 * MCPJAM_YAML_MAX_BYTES's approach (UTF-8 bytes, not code units — code units
 * undercount multi-byte text and would admit inputs past the in-sandbox cap
 * this bound exists to mirror). READMEs are routinely larger than a config
 * file, so they get their own, larger cap.
 *
 * Oversize input is IGNORED, never fatal: this is a heuristic rung, and a
 * 4MB generated README is not the author's fault.
 */
export const DETECTION_MAX_BYTES = 64 * 1024;
export const DETECTION_README_MAX_BYTES = 256 * 1024;

/** Defaults when nothing hints otherwise. Match the fixture recipe. */
const DEFAULT_PORT = 3001;
const DEFAULT_MCP_PATH = "/mcp";

/**
 * RULE A — shell metacharacters that make a command UNPROVABLE.
 *
 * `$` / backtick (command substitution, parameter expansion), `|` `;` `&`
 * (chaining, so the thing that actually starts the server may be a token we
 * never analysed), `<` `>` (redirection), `(` `)` (subshells), `{` `}` (brace
 * expansion), `*` `?` `[` `]` (globbing), `~` (home expansion — a path OUT of
 * the checkout), `\` (quote removal), and newlines.
 *
 * `node "$(npm root)"/@acme/server/bin.js` is the motivating case: the entry
 * path does not exist as a literal anywhere in the script, the shell builds it
 * at runtime, and it lands on an INSTALLED PACKAGE. There is no literal-path
 * check that can catch that — not because we wrote the wrong regex, but because
 * the information is not in the text. So the answer is not a better path check,
 * it is refusing to reason about shell-computed commands at all.
 *
 * Applied to the START body only. `build` may chain and expand freely: a build
 * that misbehaves yields `build_failed`, which is a red check with honest
 * blame, whereas a start we cannot analyse yields a GREEN check on unknown
 * code. Only the second one lies.
 *
 * Quotes (`'` `"`) are deliberately NOT here: quoting alone computes nothing,
 * and the tokenizer below strips them, so `sh -c "npx pkg"` is still caught as
 * the launcher it is.
 */
const UNPROVABLE_SHELL_RE = /[$`|;&<>(){}\[\]*?~\\\n\r]/;

/**
 * RULE B — PACKAGE LAUNCHERS: commands whose job is to fetch a published
 * package and run it. Enumerated deliberately rather than pattern-guessed,
 * because every entry is a decision about what "runs the checkout" means.
 *
 * Commands that fetch no matter what they are followed by:
 *   `npx`, `pnpx`, `bunx`, `uvx`.
 */
const ALWAYS_FETCHING_COMMANDS: ReadonlySet<string> = new Set([
  "npx",
  "pnpx",
  "bunx",
  "uvx",
]);

/**
 * Package managers that fetch only under a particular SUBCOMMAND. Each entry is
 * re-verified here, with the reason it is (or is not) a fetcher:
 *
 *   npm   `exec`, `x` — npm documents `npm exec` as running "a local or REMOTE
 *         npm package"; `npm x` is its alias. Both install from the registry.
 *   pnpm  `dlx` — "fetch a package from the registry and run it". `pnpm exec`
 *         is NOT a fetcher: pnpm splits the two verbs, and `exec` runs only
 *         what is already in the project's node_modules/.bin.
 *   yarn  `dlx` — berry's fetch-and-run. `yarn run` executes a package.json
 *         script, no fetch.
 *   bun   `x` — the long form of `bunx`. `bun run` executes a local script.
 *   uv    `tool` (`uv tool run` is uvx's long form, `uv tool install` fetches),
 *         and the `--from` / `--with` OPTIONS, which are the sharp edge here:
 *         `uv run --from acme-mcp acme` runs the PUBLISHED package even though
 *         the subcommand is the innocuous `uv run`. Bare `uv run <script>` is
 *         not a fetcher — it runs a console script from the synced project env.
 *   pipx  `run` (fetch-and-run), `install`.
 *
 * DELIBERATELY ABSENT, re-verified: `pnpm exec`, `yarn run`, `bun run`,
 * `uv run`. Those only run something already resolved into the project, and
 * banning them would discard the overwhelmingly common `"build": "tsc"` shape
 * for no safety gain. A dependency used to BUILD the checkout is fine; a
 * dependency used AS the server is what the other rules reject.
 */
const FETCHING_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  npm: new Set(["exec", "x"]),
  pnpm: new Set(["dlx"]),
  yarn: new Set(["dlx"]),
  bun: new Set(["x"]),
  uv: new Set(["tool", "--from", "--with"]),
  pipx: new Set(["run", "install"]),
};

/** Any absolute URL in a command — `node https://…`, `curl … | sh`, etc. */
const REMOTE_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Split a script body into command segments, then into tokens.
 *
 * Crude on purpose — this is not a shell parser and must never be mistaken for
 * one. It exists so launcher detection can be TOKEN-based instead of
 * adjacency-based, which is what finding 1 (`npm --yes exec -- pkg`) proved is
 * necessary: any regex that requires `npm` and `exec` to be neighbours loses to
 * an interleaved option, and there is an unbounded supply of options.
 *
 * Quotes are stripped rather than honoured, so `sh -c "npx pkg"` tokenizes to
 * the launcher it will actually run. That over-tokenizes some inputs, which for
 * a suppression rule is the safe direction.
 */
function shellSegments(body: string): string[][] {
  return body
    .split(/[\n\r;|&()]+/)
    .map((segment) =>
      segment
        .split(/\s+/)
        .map((token) => token.replace(/['"`]/g, ""))
        .filter((token) => token.length > 0),
    )
    .filter((segment) => segment.length > 0);
}

/** Last path component, lowercased: `./node_modules/.bin/NPX` -> `npx`. */
function commandName(token: string): string {
  const parts = token.split("/");
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

/**
 * True when any segment invokes a package manager with a fetching subcommand
 * ANYWHERE in its token list, or a command that always fetches.
 *
 * "Anywhere before `--`" rather than "immediately after the manager" is the
 * whole fix for finding 1: `npm --yes exec -- @acme/pkg`, `npm -y x pkg`,
 * `npm --loglevel warn exec pkg` and every other permutation reduce to the same
 * token set. The scan stops at `--` because tokens after it are arguments, not
 * subcommands (`npm run build -- --dlx-ish-flag` is not a fetch).
 *
 * KNOWN OVER-REJECTION, accepted: a package.json script literally named `x` or
 * `exec` makes `npm run x` look like `npm x`. That repo gets a resolver miss
 * and can declare `mcpjam.yaml`. Under the inversion, an over-rejection is a
 * cost we pay in recall; the alternative is reasoning about which position a
 * token occupies, which is exactly the adjacency assumption that has now failed
 * three times.
 */
function usesPackageLauncher(body: string): boolean {
  for (const segment of shellSegments(body)) {
    for (let i = 0; i < segment.length; i++) {
      const name = commandName(segment[i]);
      if (ALWAYS_FETCHING_COMMANDS.has(name)) return true;
      const fetching = FETCHING_SUBCOMMANDS[name];
      if (!fetching) continue;
      for (let j = i + 1; j < segment.length; j++) {
        const token = segment[j].toLowerCase();
        if (token === "--") break;
        if (fetching.has(token)) return true;
      }
    }
  }
  return false;
}

/**
 * Paths that are inside the tree but NOT checkout source: an installed
 * dependency (`node_modules/…`) or anything reached by climbing out of the
 * checkout (`../`). `node dist/index.js` tests the PR; `node
 * node_modules/@acme/server/bin.js` tests the published package the PR merely
 * depends on, and goes green regardless of what the PR broke.
 */
const NODE_MODULES_RE = /(^|[^A-Za-z0-9_.\-])node_modules\//i;
const PARENT_TRAVERSAL_RE = /(^|[^A-Za-z0-9_.\-])\.\.\//;

/**
 * Paths reach the probe URL, so they are constrained rather than trusted.
 * README/server.json are untrusted PR content; a hint that isn't a plain,
 * short, absolute path is dropped and the default is kept.
 */
const SAFE_PATH_RE = /^\/[A-Za-z0-9._~\-/]{0,64}$/;

/**
 * The relative-path counterpart of SAFE_PATH_RE, same character allowlist, used
 * for a `bin` value that we splice into a shell command.
 *
 * This is VALIDATION, not escaping. `start` is run under `bash -lc`, where
 * double quotes still expand `$(…)`, backticks and `$VAR` — so a bin of
 * `dist/x$(id).js` would command-substitute no matter how it is quoted. The
 * only honest options are "reject" or "spawn without a shell", and rejecting is
 * the one that fits a heuristic rung: an author whose bin path needs shell
 * metacharacters can write mcpjam.yaml instead.
 */
const SAFE_RELATIVE_PATH_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._~\-/]{1,128}$/;

type NodePackageManager = "npm" | "pnpm" | "yarn";

/** Per-candidate scoring inputs; higher total sorts first. */
type Scored = { recipe: ResolvedRecipe; score: number };

function withinCap(raw: string | null, cap: number): string | null {
  if (raw === null) return null;
  return Buffer.byteLength(raw, "utf8") > cap ? null : raw;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const doc: unknown = JSON.parse(raw);
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
      return null;
    }
    return doc as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") out[key] = val;
  }
  return out;
}

/**
 * True when running this script body would execute something OTHER than the
 * checkout. Checked on the SCRIPT BODY, not on the command we emit: we emit
 * `npm start`, but if `scripts.start` is `npx -y @acme/server` then `npm start`
 * is a published-package launcher wearing a local disguise.
 */
function isRemoteInvocation(body: string): boolean {
  return usesPackageLauncher(body) || REMOTE_URL_RE.test(body);
}

/**
 * True when the command computes part of itself at runtime, so no static claim
 * about what it runs can be made. See UNPROVABLE_SHELL_RE.
 */
function isUnprovableShell(body: string): boolean {
  return UNPROVABLE_SHELL_RE.test(body);
}

/**
 * True when the command names something that is in the working tree but is not
 * checkout source — an installed dependency, or a path above the checkout root.
 * Same failure mode as `isRemoteInvocation`, one step closer to home: the
 * command runs, the check goes green, and it proved nothing about the PR.
 */
function escapesCheckout(body: string): boolean {
  return NODE_MODULES_RE.test(body) || PARENT_TRAVERSAL_RE.test(body);
}

// ---------------------------------------------------------------------------
// Rule C: verify entry points against the actual checkout
// ---------------------------------------------------------------------------

/**
 * Normalize the caller's listing into a path -> kind lookup. Leading `./` is
 * stripped and separators are POSIX, so `./dist/cli.js` and `dist/cli.js` are
 * the same file — a caller assembling this from `git ls-files` or a directory
 * walk should not have to know which spelling we compare against.
 *
 * An entry with a missing or unrecognised `kind` is recorded as `'other'`, not
 * as a file: an unclassifiable entry is exactly the case where we know least,
 * and the whole point of carrying the kind is that "we don't know" must not
 * read as "regular file".
 */
type Checkout = ReadonlyMap<string, RepoFileKind>;

function checkoutFiles(
  repoFiles: readonly RepoFileEntry[] | undefined,
): Checkout | null {
  // An EMPTY listing means "we could not list the checkout", not "the checkout
  // is empty" — no repo we can detect has zero files. Treating it as absent
  // keeps the reasons honest (a caller whose `git ls-files` failed gets the
  // no-listing reason, not "your entry point is a dependency").
  if (!repoFiles || repoFiles.length === 0) return null;
  const out = new Map<string, RepoFileKind>();
  for (const entry of repoFiles) {
    if (typeof entry !== "object" || entry === null) continue;
    const path = entry.path;
    if (typeof path !== "string" || path === "") continue;
    const kind: RepoFileKind =
      entry.kind === "file" || entry.kind === "symlink" ? entry.kind : "other";
    out.set(path.replace(/\\/g, "/").replace(/^\.\//, ""), kind);
  }
  return out.size === 0 ? null : out;
}

/**
 * Absolute paths, in every spelling that reaches a filesystem OUTSIDE the
 * checkout: POSIX (`/etc/foo.js`), Windows drive-qualified (`C:/x.js`, and
 * `C:x.js`, which is drive-relative, not checkout-relative), and UNC (`//host`,
 * which the POSIX branch already covers).
 *
 * The docblock's central claim — "a relative path can only resolve inside the
 * checkout" — is only true of paths that are actually relative, and nothing was
 * enforcing that. This is that enforcement, and it applies at EVERY acceptance
 * site, including the build-output one where an absent path used to be waved
 * through on the strength of a build script existing.
 */
const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:)/;

function isCheckoutRelative(path: string): boolean {
  return !ABSOLUTE_PATH_RE.test(path) && !escapesCheckout(path);
}

/** Extensions that make a token an ENTRY POINT rather than an argument. */
const SCRIPT_EXTENSION_RE = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|py)$/i;

/**
 * The file paths a start command would execute. Options (`--port`) and bare
 * words (`node`, a script name) are not entry points; a token with a script
 * extension is.
 *
 * Only meaningful AFTER `isUnprovableShell` has passed: a command that builds
 * its path at runtime has no such token, which is precisely why it is rejected
 * before we get here rather than "found to have zero entry points".
 */
function entryPaths(body: string): string[] {
  const out: string[] = [];
  for (const segment of shellSegments(body)) {
    for (const token of segment) {
      if (token.startsWith("-")) continue;
      if (SCRIPT_EXTENSION_RE.test(token)) out.push(token.replace(/^\.\//, ""));
    }
  }
  return out;
}

/**
 * How well is this entry path established as checkout code?
 *
 *   'rejected'   — suppress the candidate entirely. Three ways to land here:
 *                  the path is not checkout-relative (absolute, drive letter,
 *                  `../`, `node_modules/`); the listing has it but NOT as a
 *                  regular file (symlink or submodule — the path text lies
 *                  about where it goes, and we refuse to chase it); or the
 *                  listing does not have it and nothing could have produced it.
 *   'verified'   — the listing has it as a regular file. This is the only
 *                  branch that PROVES anything.
 *   'unverified' — accepted on a plausibility argument, not on evidence:
 *                  a relative path a build step could have produced (the
 *                  `node dist/index.js` + `npm run build` shape), or the
 *                  degenerate case of no listing at all.
 *
 * Note what is NOT here any more: "some `scripts.build` exists, therefore the
 * output is checkout-derived". A build script runs arbitrary code and can copy
 * `node_modules/acme/server.js` into `dist/index.js`. That case now yields
 * 'unverified', which is a promise that A3 will settle it at runtime, not a
 * claim that we already did.
 */
type EntryVerdict = "verified" | "unverified" | "rejected";

function verifyEntryPath(
  path: string,
  checkout: Checkout | null,
  hasBuildStep: boolean,
): EntryVerdict {
  if (!isCheckoutRelative(path)) return "rejected";
  if (!checkout) return "unverified";
  const kind = checkout.get(path);
  if (kind === "file") return "verified";
  // Present but not a regular file: a symlink can point at a dependency or out
  // of the checkout entirely, and a submodule is someone else's commit. Both
  // are unresolvable provenance, which is a miss, and a miss is recoverable.
  if (kind !== undefined) return "rejected";
  return hasBuildStep ? "unverified" : "rejected";
}

/** Weakest verdict wins: one 'rejected' sinks the candidate. */
function weakest(verdicts: readonly EntryVerdict[]): EntryVerdict {
  if (verdicts.includes("rejected")) return "rejected";
  return verdicts.includes("unverified") ? "unverified" : "verified";
}

/**
 * Interpreters that run a script ARGUMENT rather than resolving a published
 * binary by name. Deliberately short, and deliberately excludes `deno` and
 * `bun`: both accept scheme-prefixed package specifiers (`deno run npm:acme`)
 * that are launchers wearing a runtime's clothes.
 */
const LOCAL_RUNTIMES: ReadonlySet<string> = new Set([
  "node",
  "nodejs",
  "tsx",
  "ts-node",
  "python",
  "python3",
]);

/**
 * Verdict for a start command that names NO script-extension entry path at all.
 *
 * This is the bare-word case: `"start": "start-server"` resolves out of
 * `node_modules/.bin`, so `npm start` launches a DEPENDENCY's published code —
 * and because it extracts zero entry paths, the old rule C simply never fired
 * on it. It passed rules A and B and `escapesCheckout` and was emitted.
 *
 * With a listing available, a bare word cannot be proven to be checkout code,
 * so it is SUPPRESSED. The two shapes that survive are the ones that do name
 * the checkout: a local runtime pointed at `.` / `./` (which is the checkout
 * root, resolved through its own package.json `main`), and a local runtime
 * pointed at an extensionless path the listing has as a regular file
 * (`node bin/cli`).
 *
 * WITHOUT a listing there is nothing to check against, so behavior is
 * unchanged — the candidate is emitted and carries 'unverified', which is the
 * honest label and the one A3 gates on.
 */
function verifyExtensionlessStart(
  body: string,
  checkout: Checkout | null,
): EntryVerdict {
  if (!checkout) return "unverified";
  const segments = shellSegments(body);
  // Rule A already rejected chaining, so a start body is one segment; anything
  // else means we mis-tokenized, and mis-tokenized is not proven.
  if (segments.length !== 1) return "rejected";
  const [command, ...rest] = segments[0];
  if (!LOCAL_RUNTIMES.has(commandName(command))) return "rejected";
  const target = rest.find((token) => !token.startsWith("-"));
  if (target === undefined) return "rejected";
  if (target === "." || target === "./") return "verified";
  const normalized = target.replace(/^\.\//, "");
  if (!isCheckoutRelative(normalized)) return "rejected";
  return checkout.get(normalized) === "file" ? "verified" : "rejected";
}

// ---------------------------------------------------------------------------
// Rule C, round 3: script indirection and lifecycle hooks
// ---------------------------------------------------------------------------

/**
 * How many levels of package.json script indirection we will follow.
 *
 * Counted in HOPS from the root script: `start -> serve` is one hop, and
 * `start -> serve -> exec` is two, which is already deeper than anything in
 * the corpus. Past the cap we SUPPRESS rather than keep walking, for the usual
 * reason — an unbounded walk is an unbounded amount of reasoning we would then
 * be claiming to have done.
 */
const MAX_SCRIPT_DEPTH = 3;

/**
 * Package managers that run a package.json script, and whether the `run` verb
 * is mandatory.
 *
 *   'run-required' — npm and bun only reach a script through `run`
 *                    (`npm run serve`, `npm run-script serve`, `bun run serve`)
 *                    or through a LIFECYCLE verb (`npm start`, `npm test`).
 *   'run-optional' — pnpm and yarn additionally accept the bare script name
 *                    (`pnpm serve`, `yarn serve`).
 *
 * Note this is the same token set rule B already scans, read for a different
 * question: rule B asks "does this FETCH", this asks "does this HAND OFF".
 */
const SCRIPT_RUNNERS: Record<string, "run-required" | "run-optional"> = {
  npm: "run-required",
  pnpm: "run-optional",
  yarn: "run-optional",
  bun: "run-required",
};

/** Verbs that reach a script without `run`. `npm start` IS `scripts.start`. */
const LIFECYCLE_VERBS: ReadonlySet<string> = new Set([
  "start",
  "stop",
  "restart",
  "test",
]);

/**
 * Runners whose ARGUMENTS are all script names: `npm-run-all build serve`,
 * `run-s clean build`, `run-p a b`. Every named script is resolved and the
 * weakest verdict wins. Glob forms (`run-s "build:*"`) never reach here — rule
 * A rejects `*` before we get this far.
 */
const MULTI_SCRIPT_RUNNERS: ReadonlySet<string> = new Set([
  "npm-run-all",
  "npm-run-all2",
  "run-s",
  "run-p",
]);

/** A script name we are willing to look up: plain, no expansion, no options. */
const SCRIPT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

type ScriptReference =
  /** Not a hand-off; analyse this body directly. */
  | { kind: "none" }
  /** A hand-off we cannot follow (computed name, missing argument). */
  | { kind: "unresolvable" }
  | { kind: "scripts"; names: string[] };

/**
 * Does this body hand off to other package.json scripts, and if so which?
 *
 * Called only AFTER rule A, so the body is a single segment: no chaining, no
 * expansion, no subshells. That is what makes this analysable at all — the
 * question "which script does this run" has a static answer precisely when the
 * command is not computing itself.
 *
 * CASE. Runner names and verbs are matched case-INSENSITIVELY (`commandName`
 * lowercases, and each verb is lowered before comparison) because those are
 * resolved through the filesystem and npm's own command table. Script NAMES are
 * returned with their ORIGINAL CASING, because `package.json` `scripts` keys are
 * case-sensitive: `npm run Serve` runs `Serve` and nothing else. Lowering the
 * name here made the lookup in `verifyScriptBody` either miss a legitimately
 * mixed-case script (suppressing a good repo) or, worse, silently verify a
 * DIFFERENT script that happened to be the lowercase spelling of the same word.
 */
function scriptReference(body: string): ScriptReference {
  const segments = shellSegments(body);
  if (segments.length !== 1) return { kind: "unresolvable" };
  const segment = segments[0];
  const runner = commandName(segment[0]);

  if (MULTI_SCRIPT_RUNNERS.has(runner)) {
    const names = segment
      .slice(1)
      .filter((token) => !token.startsWith("-"));
    if (names.length === 0) return { kind: "unresolvable" };
    if (!names.every((name) => SCRIPT_NAME_RE.test(name))) {
      return { kind: "unresolvable" };
    }
    return { kind: "scripts", names };
  }

  const style = SCRIPT_RUNNERS[runner];
  if (!style) return { kind: "none" };

  // Skip manager-level options (`npm --silent run serve`) and stop at `--`,
  // after which everything is an argument to the script, not a verb.
  const rest: string[] = [];
  for (const token of segment.slice(1)) {
    if (token === "--") break;
    if (token.startsWith("-")) continue;
    rest.push(token);
  }
  if (rest.length === 0) return { kind: "unresolvable" };

  const verb = rest[0].toLowerCase();
  if (verb === "run" || verb === "run-script") {
    const name = rest[1];
    if (name === undefined || !SCRIPT_NAME_RE.test(name)) {
      return { kind: "unresolvable" };
    }
    return { kind: "scripts", names: [name] };
  }
  // A lifecycle VERB is a fixed npm identifier, not a user-chosen script name:
  // `npm Start` is not a command npm accepts, so the script it would reach is
  // the canonical lowercase one.
  if (LIFECYCLE_VERBS.has(verb)) return { kind: "scripts", names: [verb] };
  if (style === "run-optional" && SCRIPT_NAME_RE.test(rest[0])) {
    // `pnpm serve`. If `serve` is not a script this resolves to nothing and the
    // caller suppresses with the "not defined" reason — which is the right
    // answer for `pnpm install` as a start command too. Original casing, not
    // `verb`: `pnpm Serve` runs `Serve`.
    return { kind: "scripts", names: [rest[0]] };
  }
  // `npm ci`, `bun index.ts`, and anything else this manager does that is not
  // a script hand-off. Not an indirection; fall through to the normal rules.
  return { kind: "none" };
}

/**
 * How strictly to judge a body in the START lifecycle.
 *
 *   'serves-probe' — this body (or something it hands off to) is the process
 *                    the probe will talk to. Full rule set, ownership included.
 *   'prepares'     — a hook that must EXIT before the probe ever connects, so
 *                    it cannot be the server. Rules A, B and escape still
 *                    apply (they are what stop it detaching a published one);
 *                    rule C does not, because `"prestart": "tsc"` is a build
 *                    tool doing its job, not a server.
 */
type ScriptRole = "serves-probe" | "prepares";

type ScriptVerdict =
  | { kind: "accepted"; proof: OwnershipProof }
  | { kind: "rejected"; reason: string };

type ScriptContext = {
  scripts: Record<string, string>;
  checkout: Checkout | null;
  hasBuildStep: boolean;
  role: ScriptRole;
};

/**
 * Label for a discard reason. CONSTANT strings plus a validated integer — the
 * script NAME is PR content and never reaches the reason text (same hygiene
 * rule as `finish`'s hint line).
 */
function chainLabel(root: string, depth: number): string {
  return depth === 0 ? root : `${root} (script indirection, level ${depth})`;
}

/**
 * Apply the rule set to one script body, following any hand-off to other
 * scripts. Returns the weakest verdict reachable from here.
 *
 * `seen` carries every script name already on this path, which is what makes
 * `"a": "npm run b"` / `"b": "npm run a"` terminate with a reason instead of a
 * stack overflow.
 */
function verifyScriptBody(
  body: string,
  root: string,
  ctx: ScriptContext,
  depth: number,
  seen: ReadonlySet<string>,
): ScriptVerdict {
  const label = chainLabel(root, depth);
  const reject = (reason: string): ScriptVerdict => ({
    kind: "rejected",
    reason: `${label} ${reason}`,
  });

  // Rule B — a fetching launcher or a remote URL, at any depth.
  if (isRemoteInvocation(body)) {
    return reject(
      "launches a published package or remote URL, not the checkout",
    );
  }
  // Rule A — shell-computed or chained, so unanalysable (and, for a hook, the
  // rule that stops it backgrounding a server it fetched).
  if (isUnprovableShell(body)) {
    return reject(
      "uses shell expansion or chaining, so what it runs cannot be established",
    );
  }
  // Ownership of the PROCESS is a start-command question. A hook running
  // `node node_modules/.bin/tsc` is a build tool doing its job; it exits, and
  // the probe never meets it.
  if (ctx.role === "serves-probe" && escapesCheckout(body)) {
    return reject("runs an installed dependency or a path outside the checkout");
  }

  const reference = scriptReference(body);
  if (reference.kind === "unresolvable") {
    return reject(
      "hands off to a script runner whose target cannot be determined statically",
    );
  }
  if (reference.kind === "scripts") {
    if (depth + 1 > MAX_SCRIPT_DEPTH) {
      return reject(
        `exceeds the maximum resolvable script-indirection depth (${MAX_SCRIPT_DEPTH})`,
      );
    }
    let proof: OwnershipProof = "verified";
    for (const name of reference.names) {
      if (seen.has(name)) {
        return reject("forms a cycle of package.json script references");
      }
      const next = ctx.scripts[name];
      if (typeof next !== "string" || next === "") {
        return reject("references a package.json script that is not defined");
      }
      // npm's pre/post hooks are not a property of `start` — they fire for
      // ARBITRARY script names, at every level of indirection. `npm run serve`
      // runs `preserve`, then `serve`, then `postserve`, so a `preserve` of
      // `nohup npx @acme/server &` would leave published code answering the
      // probe while the tracked `serve` body passed inspection. The hooks get
      // the same treatment the ROOT lifecycle's hooks get: rules A + B, role
      // 'prepares' (they must exit before the probe connects, so rule C would
      // suppress `"preserve": "tsc"` for no safety gain).
      for (const hook of [`pre${name}`, `post${name}`]) {
        const hookBody = ctx.scripts[hook];
        if (typeof hookBody !== "string" || hookBody === "") continue;
        if (seen.has(hook)) {
          return reject("forms a cycle of package.json script references");
        }
        const hookVerdict = verifyScriptBody(
          hookBody,
          root,
          { ...ctx, role: "prepares" },
          depth + 1,
          new Set([...seen, name, hook]),
        );
        if (hookVerdict.kind === "rejected") return hookVerdict;
        if (hookVerdict.proof === "unverified") proof = "unverified";
      }
      const verdict = verifyScriptBody(
        next,
        root,
        ctx,
        depth + 1,
        new Set([...seen, name]),
      );
      if (verdict.kind === "rejected") return verdict;
      if (verdict.proof === "unverified") proof = "unverified";
    }
    return { kind: "accepted", proof };
  }

  // A hook has nothing left to prove: it exits before the probe connects.
  if (ctx.role === "prepares") return { kind: "accepted", proof: "verified" };

  // Rule C — ownership of what the probe will actually talk to.
  const paths = entryPaths(body);
  const entryVerdict =
    paths.length > 0
      ? weakest(
          paths.map((path) =>
            verifyEntryPath(path, ctx.checkout, ctx.hasBuildStep),
          ),
        )
      : verifyExtensionlessStart(body, ctx.checkout);
  if (entryVerdict === "rejected") {
    return reject(
      paths.length > 0
        ? "runs a file that is not proven to be checkout code (absent from the listing, not a regular file, or not a checkout-relative path)"
        : "names no verifiable checkout file — a bare command name resolved from node_modules/.bin",
    );
  }
  return { kind: "accepted", proof: entryVerdict };
}

/**
 * Commands that DETACH a process, so that it can outlive the script that
 * started it and still be listening when the probe connects. `&&` is not a
 * match: the first alternative requires the `&` to be neither preceded nor
 * followed by another `&`.
 */
const BACKGROUNDING_RE =
  /(?:^|[^&|])&(?!&)|\bnohup\b|\bsetsid\b|\bdisown\b|\bpm2\b|\bforever\b|\btmux\b/;

/**
 * INSTALL-lifecycle hooks: the narrow rule, see the module docblock. A hook
 * that runs something foreign in the FOREGROUND either exits or hangs the
 * build — neither is a false green. A hook that runs it AND detaches can leave
 * a published server listening on the probe port before `start` ever runs, and
 * that is the one shape we refuse.
 *
 * The list is npm's documented `install`/`ci` lifecycle order (npm 11.x):
 * preinstall, install, postinstall, prepublish (deprecated but still fired),
 * then the PREPARE trio — `preprepare`, `prepare`, `postprepare`. The trio's
 * outer two were missing, so `"preprepare": "nohup npx @acme/server &"` was
 * never inspected at all.
 */
const INSTALL_LIFECYCLE = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
] as const;

/**
 * Tokens that WRAP another command rather than being one. `nohup acme-server`
 * is a launch of `acme-server`, not of `nohup`.
 */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  "nohup",
  "setsid",
  "disown",
  "env",
  "exec",
  "time",
]);

/**
 * A plain command WORD. Anchored to a letter/`_`/`@`/`.` first character on
 * purpose: `shellSegments` is a crude tokenizer that splits on `&`, so
 * `2>&1` leaves fragments like `2>` and `1` behind. Neither is a command, and
 * treating them as one would suppress `"postinstall": "node x.js >/dev/null
 * 2>&1 &"` — checkout code — for a typographic reason.
 */
const BARE_COMMAND_RE = /^[A-Za-z_@.][A-Za-z0-9_@.:+-]*$/;

/**
 * Shell ASSIGNMENT syntax: `NAME=` prefixing a command word.
 *
 * Matched STRUCTURALLY — on the name and the `=`, never on what the value
 * looks like. The previous spelling also required the token to contain no `/`,
 * on the theory that a slash means "path, therefore command". A path-valued
 * assignment (`FOO=/opt/x nohup acme-server &`) is ordinary shell, so that
 * token read as the COMMAND, `escapesCheckout("FOO=/opt/x")` said false, and
 * the loop returned before ever reaching `acme-server`. Value shape is not a
 * signal; position and syntax are.
 */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Redirection fragments left behind by `shellSegments`, which is a tokenizer
 * and not a shell: `node x.js >/dev/null 2>&1` yields `>/dev/null` and `2>`.
 * They are neither options nor entry points, so the entry-argument search
 * below must step over them rather than mistake one for the file being run.
 */
const REDIRECTION_RE = /^\d*[<>]/;

/**
 * Flags that make an accepted runtime execute code it was handed INLINE, or a
 * module resolved out of the installed dependency tree, instead of a file from
 * the checkout. `nohup node -e "require('acme').serve()" &` is a published
 * server wearing a local runtime's name: the runtime is ours, the code is not,
 * and the old rule waved through every `LOCAL_RUNTIMES` command on the
 * strength of the runtime alone.
 *
 * Enumerated per runtime because the spellings differ:
 *   node, nodejs  `-e` / `--eval` and `-p` / `--print` — node also accepts the
 *                 `--eval=CODE` joined form, which is why the check compares
 *                 the part before `=`.
 *   tsx           the same set: tsx forwards node's CLI flags verbatim.
 *   ts-node       the same set, as its own options.
 *   python,       `-c` (inline program) and `-m` (run an INSTALLED module by
 *   python3       dotted name — not inline code, but the identical hazard:
 *                 the name is resolved from site-packages, never from a
 *                 checkout path, so no listing lookup can ever own it).
 *
 * This list is a fast path, not the whole guard. A flag we did not enumerate
 * still has to get past the entry-argument check, which requires the first
 * non-flag token to be a path the checkout owns — so an unlisted code-injecting
 * flag fails there instead of here.
 */
const NODE_INLINE_CODE_FLAGS: ReadonlySet<string> = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
]);
const PYTHON_INLINE_CODE_FLAGS: ReadonlySet<string> = new Set(["-c", "-m"]);
const INLINE_CODE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  node: NODE_INLINE_CODE_FLAGS,
  nodejs: NODE_INLINE_CODE_FLAGS,
  tsx: NODE_INLINE_CODE_FLAGS,
  "ts-node": NODE_INLINE_CODE_FLAGS,
  python: PYTHON_INLINE_CODE_FLAGS,
  python3: PYTHON_INLINE_CODE_FLAGS,
};

/** What the install-hook guard needs in order to judge an entry argument. */
type InstallGuardContext = {
  checkout: Checkout | null;
  hasBuildStep: boolean;
};

/**
 * A local runtime was found in command position of a DETACHED segment. Is the
 * code it will run foreign?
 *
 * "The argument decides what runs, and the argument is checkout code" was the
 * old assumption, and it is only true when there IS an argument and it names
 * checkout code. Three ways it does not:
 *
 *   - an inline-code flag (see INLINE_CODE_FLAGS) — the argument is a program,
 *     not a path, and `require('acme')` inside it serves a dependency;
 *   - no argument at all (`nohup node &`) — nothing names checkout code;
 *   - an argument the checkout does not own, which is exactly the judgement
 *     `verifyEntryPath` already makes for start commands (absolute paths,
 *     `../`, `node_modules/`, symlinks, and absent files without a build step).
 */
function runtimeRunsForeignCode(
  runtime: string,
  args: readonly string[],
  ctx: InstallGuardContext,
): boolean {
  const inlineFlags = INLINE_CODE_FLAGS[runtime];
  if (inlineFlags) {
    for (const token of args) {
      // `--eval=CODE` and `--eval CODE` are the same flag.
      const flag = token.split("=")[0];
      if (inlineFlags.has(flag)) return true;
    }
  }
  // ANY option present ⇒ foreign, without trying to work out which token is
  // the entry. Picking "the first token that does not start with `-`" is wrong
  // the moment an option takes a VALUE: in
  // `node --require ./scripts/boot.js node_modules/acme/server.js`
  // that heuristic returns `./scripts/boot.js` — the option's value — verifies
  // it as checkout code, and never looks at the real entry beside it.
  //
  // Getting this right means implementing the runtime's CLI grammar (which
  // options take values, `--opt=v` vs `--opt v`, per runtime, per version).
  // That is a parser whose bugs are false greens, so it is not worth writing:
  // this branch only judges a runtime that was DETACHED inside an install
  // hook, where the legitimate shape (`nohup node dist/index.js &`) needs no
  // options at all. Conservative rejection costs a resolver miss the author
  // can fix with mcpjam.yaml; the alternative costs a silent false green.
  if (args.some((token) => token.startsWith("-"))) return true;
  const entry = args.find((token) => !REDIRECTION_RE.test(token));
  if (entry === undefined) return true;
  // `node .` runs the checkout root through its own package.json `main`.
  if (entry === "." || entry === "./") return false;
  return (
    verifyEntryPath(
      entry.replace(/^\.\//, ""),
      ctx.checkout,
      ctx.hasBuildStep,
    ) === "rejected"
  );
}

/**
 * Does this body launch a binary that npm resolved from `node_modules/.bin`
 * (or an explicit path into `node_modules`), rather than checkout code?
 *
 * This is the half of the install-hook guard that `isRemoteInvocation` cannot
 * see. `"prepare": "nohup acme-mcp-server >/dev/null 2>&1 &"` fetches nothing —
 * npm has ALREADY installed `acme-mcp-server` and put it on PATH by the time
 * install hooks run — yet it leaves published dependency code listening before
 * the validated start command ever binds, which is the same false green a
 * detached `npx` produces.
 *
 * Only the COMMAND position of each segment is examined, and reaching it means
 * stepping over the things that PRECEDE a command: options, environment
 * assignments, and wrappers. A local runtime found there is judged on what it
 * was pointed at (`runtimeRunsForeignCode`), not accepted on its name.
 */
function launchesInstalledBinary(
  body: string,
  ctx: InstallGuardContext,
): boolean {
  for (const segment of shellSegments(body)) {
    for (let i = 0; i < segment.length; i++) {
      const token = segment[i];
      if (token.startsWith("-")) continue;
      // `FOO=1 BAR=/opt/x acme-server` — assignments prefix the command, and
      // any number of them may. `env FOO=1 acme-server` reaches the same place
      // via the `env` wrapper below.
      if (ENV_ASSIGNMENT_RE.test(token)) continue;
      const name = commandName(token);
      if (COMMAND_WRAPPERS.has(name)) continue;
      if (token.includes("/")) {
        // A PATH, not a PATH lookup. Only one that leaves the checkout is
        // somebody else's code; a relative path inside it is the checkout's.
        // A runtime named by an in-checkout path (`/usr/bin/node`) is still a
        // runtime, and its argument still has to be ours.
        if (LOCAL_RUNTIMES.has(name) && !escapesCheckout(token)) {
          if (runtimeRunsForeignCode(name, segment.slice(i + 1), ctx)) {
            return true;
          }
          break;
        }
        return escapesCheckout(token);
      }
      if (!BARE_COMMAND_RE.test(token)) break;
      if (LOCAL_RUNTIMES.has(name)) {
        if (runtimeRunsForeignCode(name, segment.slice(i + 1), ctx)) return true;
        break;
      }
      return true;
    }
  }
  return false;
}

/**
 * The install-hook shape that can produce a false green: DETACHED plus foreign.
 * Foreign is either a fetch (`npx @acme/server`), a binary npm installed for us
 * (`acme-mcp-server`), or a local runtime pointed at code we do not own
 * (`node -e "…"`). A NON-detached foreign command stays acceptable — it must
 * exit before npm proceeds, so it cannot still be answering the probe.
 */
function detachesForeignProcess(
  body: string,
  ctx: InstallGuardContext,
): boolean {
  if (!BACKGROUNDING_RE.test(body)) return false;
  return isRemoteInvocation(body) || launchesInstalledBinary(body, ctx);
}

/**
 * `detachesForeignProcess` across the install lifecycle, FOLLOWING statically
 * resolvable script references — the same recursion `buildFetchesRemotely`
 * uses for rule B, for the same reason. `"prepare": "npm run sneaky"` with
 * `"sneaky": "nohup acme-server &"` detaches exactly as effectively as writing
 * the launch in `prepare` itself, and the literal-body check never saw it:
 * reference-following was wired for the start and build lifecycles only.
 *
 * The referenced script's OWN `pre`/`post` hooks are followed too, because npm
 * runs them; depth is capped at MAX_SCRIPT_DEPTH; `seen` terminates cycles.
 *
 * Returns the HOP COUNT at which the detached launch was found, or null. That
 * number is the only thing distinguishing the two suppression reasons, and it
 * is an integer we computed — no script name, and therefore no PR content,
 * reaches the reason text.
 */
function installDetachesForeign(
  body: string,
  scripts: Record<string, string>,
  ctx: InstallGuardContext,
  depth: number,
  seen: ReadonlySet<string>,
): number | null {
  if (detachesForeignProcess(body, ctx)) return depth;
  if (depth + 1 > MAX_SCRIPT_DEPTH) return null;
  const reference = scriptReference(body);
  if (reference.kind !== "scripts") return null;
  for (const name of reference.names) {
    for (const hook of [`pre${name}`, name, `post${name}`]) {
      if (seen.has(hook)) continue;
      const next = scripts[hook];
      if (typeof next !== "string" || next === "") continue;
      const found = installDetachesForeign(
        next,
        scripts,
        ctx,
        depth + 1,
        new Set([...seen, hook]),
      );
      if (found !== null) return found;
    }
  }
  return null;
}

/** BUILD-lifecycle hooks that `<pm> run build` drags along. */
const BUILD_LIFECYCLE = ["prebuild", "build", "postbuild"] as const;

/**
 * Rule B across the build lifecycle, FOLLOWING statically resolvable script
 * references. `"build": "npm run bundle"` with `"bundle": "npx @acme/dist-
 * bundle"` fetches the artifact just as effectively as writing the `npx` in
 * `build` itself, and the literal-body check never saw it.
 *
 * Deliberately rule B ONLY, and deliberately silent on what it cannot resolve.
 * Build steps chain and expand freely by design (`tsc && chmod +x dist/*.js`),
 * so an unresolvable reference here is NOT a rejection the way it is in the
 * start lifecycle — a build that misbehaves yields `build_failed`, which is an
 * honest red. The referenced script's own pre/post hooks are followed too,
 * for the same reason the start lifecycle follows them.
 */
function buildFetchesRemotely(
  body: string,
  scripts: Record<string, string>,
  depth: number,
  seen: ReadonlySet<string>,
): boolean {
  if (isRemoteInvocation(body)) return true;
  if (depth + 1 > MAX_SCRIPT_DEPTH) return false;
  const reference = scriptReference(body);
  if (reference.kind !== "scripts") return false;
  for (const name of reference.names) {
    for (const hook of [`pre${name}`, name, `post${name}`]) {
      if (seen.has(hook)) continue;
      const next = scripts[hook];
      if (typeof next !== "string" || next === "") continue;
      if (
        buildFetchesRemotely(next, scripts, depth + 1, new Set([...seen, hook]))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Candidate on-disk locations for a python `module.path` — flat layout, src
 * layout, module and package forms. `fastmcp.cli` is checkout code only if one
 * of these is a real file in the checkout; if none is, the module belongs to a
 * DEPENDENCY and `uv run <script>` would start it. That is finding 3.
 */
function pythonModuleFiles(module: string): string[] {
  const relative = module.split(".").join("/");
  return [
    `${relative}.py`,
    `${relative}/__init__.py`,
    `src/${relative}.py`,
    `src/${relative}/__init__.py`,
  ];
}

// ---------------------------------------------------------------------------
// Hints (port/path only — NEVER a command)
// ---------------------------------------------------------------------------

type Hint = {
  port?: number;
  path?: string;
  /** Constant, content-free label for evidence. */
  source: "server.json" | "README";
};

function portFromUrl(url: string): { port?: number; path?: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // Only LOCAL urls are usable hints. A hint pointing at a hosted deployment
  // (https://mcp.acme.com/v1) says nothing about which port the checkout binds
  // inside our sandbox, and its path may not even be served by the local build.
  const isLocal =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "0.0.0.0" ||
    parsed.hostname === "[::1]";
  if (!isLocal) return null;

  // `URL.port` is EMPTY for a scheme-default port, so `http://localhost/mcp`
  // parses with no port at all. Falling through to DEFAULT_PORT there would
  // probe 3001 on a repo that explicitly documented 80 — an author who wrote a
  // scheme-default URL stated a port just as much as one who wrote `:8080`.
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : undefined;
  const out: { port?: number; path?: string } = {};
  if (port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535) {
    out.port = port;
  }
  if (path !== undefined && SAFE_PATH_RE.test(path)) out.path = path;
  return out.port === undefined && out.path === undefined ? null : out;
}

/**
 * Registry manifest hint. The registry describes streamable-http servers with
 * a `remotes[]` array; only that shape is read, and only for port/path. The
 * `packages[]` array (which names PUBLISHED artifacts) is deliberately ignored
 * — it is exactly the "run the published thing" trap this rung refuses.
 */
function hintFromServerJson(raw: string | null): Hint | null {
  const doc = parseJsonObject(withinCap(raw, DETECTION_MAX_BYTES));
  if (!doc) return null;
  const remotes = doc.remotes;
  if (!Array.isArray(remotes)) return null;
  for (const remote of remotes) {
    if (typeof remote !== "object" || remote === null) continue;
    const entry = remote as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type : "";
    if (type !== "streamable-http" && type !== "http") continue;
    if (typeof entry.url !== "string") continue;
    const hint = portFromUrl(entry.url);
    if (hint) return { ...hint, source: "server.json" };
  }
  return null;
}

/**
 * README hint: the first localhost HTTP URL that looks like an MCP endpoint.
 * READMEs are prose plus config blobs, so this is the weakest signal in the
 * module — it only ever moves port/path, never the command.
 */
function hintFromReadme(raw: string | null): Hint | null {
  const text = withinCap(raw, DETECTION_README_MAX_BYTES);
  if (text === null) return null;
  const matches = text.match(
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{1,5})?(?:\/[A-Za-z0-9._~\-/]*)?/g,
  );
  if (!matches) return null;
  for (const match of matches) {
    const hint = portFromUrl(match);
    // Require a path segment: a bare `http://localhost:3000` in a README is
    // usually the docs site or a web UI, not the MCP endpoint.
    if (hint?.path) return { ...hint, source: "README" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

function nodeCommands(pm: NodePackageManager, hasLockfile: boolean) {
  // Frozen installs are the point of a lockfile: they fail loudly if the PR
  // forgot to update it, instead of quietly resolving different dependencies
  // than the author tested against.
  switch (pm) {
    case "pnpm":
      return {
        install: "pnpm install --frozen-lockfile",
        run: (script: string) => `pnpm run ${script}`,
        start: "pnpm start",
      };
    case "yarn":
      return {
        install: "yarn install --frozen-lockfile",
        run: (script: string) => `yarn run ${script}`,
        start: "yarn start",
      };
    case "npm":
      return {
        install: hasLockfile ? "npm ci" : "npm install",
        run: (script: string) => `npm run ${script}`,
        start: "npm start",
      };
  }
}

/**
 * Resolve `bin` to a single local entry path, or null. `bin` is either a
 * string or a name→path map; a map with several entries is ambiguous (which
 * one is the server?) and we do not guess.
 */
function singleBinPath(pkg: Record<string, unknown>): string | null {
  const bin = pkg.bin;
  if (typeof bin === "string") return bin;
  if (typeof bin === "object" && bin !== null && !Array.isArray(bin)) {
    const entries = Object.entries(bin).filter(
      ([, value]) => typeof value === "string",
    ) as [string, string][];
    if (entries.length === 1) return entries[0][1];
  }
  return null;
}

function detectNode(
  files: DetectionInputs,
  hint: Hint | null,
  discarded: string[],
): Scored[] {
  const pkg = parseJsonObject(withinCap(files.packageJson, DETECTION_MAX_BYTES));
  if (!pkg) {
    if (files.packageJson !== null) {
      discarded.push("package.json present but unreadable (too large or not valid JSON)");
    }
    return [];
  }

  // Bun is a v1 non-goal and its lockfile is binary, so it is not even an
  // input; a bun-only repo simply has no lockfile here and falls into the
  // `npm install` fallback. That is acceptable (npm can usually install a bun
  // project) and the corpus counts whether it actually works.
  const managers: { pm: NodePackageManager; lock: boolean; why: string }[] = [];
  if (files.pnpmLockYaml !== null) {
    managers.push({ pm: "pnpm", lock: true, why: "pnpm-lock.yaml" });
  }
  if (files.yarnLock !== null) {
    managers.push({ pm: "yarn", lock: true, why: "yarn.lock" });
  }
  if (files.packageLockJson !== null) {
    managers.push({ pm: "npm", lock: true, why: "package-lock.json" });
  }
  if (managers.length === 0) {
    // No lockfile at all: still worth a shot, but ranked below any lockfile
    // candidate — `npm install` resolves whatever is current, so a green check
    // proves less than a frozen install would.
    managers.push({ pm: "npm", lock: false, why: "package.json (no lockfile)" });
  }

  const scripts = asStringRecord(pkg.scripts);
  const deps = {
    ...asStringRecord(pkg.dependencies),
    ...asStringRecord(pkg.devDependencies),
  };
  // Matched by SCOPE prefix rather than by the one exact package name: any
  // dependency under the official scope (server-*, and whatever ships next) is
  // at least as good an MCP signal as the sdk itself.
  const hasMcpSdk = Object.keys(deps).some(
    (name) =>
      name.startsWith("@modelcontextprotocol/") ||
      name === "@mcpjam/sdk" ||
      name === "fastmcp" ||
      name === "mcp-framework",
  );

  const checkout = checkoutFiles(files.repoFiles);
  const hasBuildStep = typeof scripts.build === "string" && scripts.build !== "";

  const out: Scored[] = [];
  for (const manager of managers) {
    const cmd = nodeCommands(manager.pm, manager.lock);
    const evidence: string[] = [`package.json + ${manager.why}`];
    let score = manager.lock ? 20 : 5;
    // Starts optimistic and only ever weakens: any entry point accepted on a
    // plausibility argument rather than on the listing downgrades the whole
    // candidate, because A3's runtime check is per-candidate, not per-path.
    let proof: OwnershipProof = "verified";

    // --- install lifecycle -------------------------------------------------
    // `npm ci` / `npm install` runs the whole install lifecycle (including the
    // prepare trio) whatever we do. Only the DETACH-something-foreign shape can
    // produce a false green here (module docblock); a foreground launch either
    // exits or fails the build loudly.
    // Reference-following (`"prepare": "npm run sneaky"`) is part of the check,
    // not an extra: one hop of indirection used to carry the launch straight
    // past the guard.
    const installGuard: InstallGuardContext = { checkout, hasBuildStep };
    let detachedAt: number | null = null;
    for (const hook of INSTALL_LIFECYCLE) {
      const body = scripts[hook];
      if (typeof body !== "string" || body === "") continue;
      detachedAt = installDetachesForeign(
        body,
        scripts,
        installGuard,
        0,
        new Set([hook]),
      );
      if (detachedAt !== null) break;
    }
    if (detachedAt !== null) {
      discarded.push(
        detachedAt === 0
          ? `${manager.pm}: an install lifecycle hook backgrounds a published package or an installed dependency binary, which could answer the probe instead of the checkout`
          : `${manager.pm}: an install lifecycle hook reaches a backgrounded published package or installed dependency binary through a package.json script reference (level ${detachedAt}), which could answer the probe instead of the checkout`,
      );
      continue;
    }

    // --- start command -----------------------------------------------------
    let start: string | null = null;
    if (scripts.start) {
      // What `<pm> start` ACTUALLY runs: prestart, then start, then poststart
      // — each of which may hand off to further scripts. `scripts.start` alone
      // was never the whole command, which is round 3's finding.
      const ctx = { scripts, checkout, hasBuildStep };
      const lifecycle: { hook: string; role: ScriptRole }[] = [
        { hook: "prestart", role: "prepares" },
        { hook: "start", role: "serves-probe" },
        { hook: "poststart", role: "prepares" },
      ];
      let rejected: string | null = null;
      for (const { hook, role } of lifecycle) {
        const body = scripts[hook];
        if (typeof body !== "string" || body === "") continue;
        const verdict = verifyScriptBody(
          body,
          `scripts.${hook}`,
          { ...ctx, role },
          0,
          new Set([hook]),
        );
        if (verdict.kind === "rejected") {
          rejected = verdict.reason;
          break;
        }
        if (verdict.proof === "unverified") proof = "unverified";
      }
      if (rejected !== null) {
        // Do not fall back to `bin` here: a repo whose own start lifecycle
        // cannot be proven local is telling us its checkout is not the thing
        // under test, and guessing a different entry point would be us
        // overruling the author.
        discarded.push(`${manager.pm}: ${rejected}`);
        continue;
      }
      // The emitted command stays `<pm> start`, NOT the resolved leaf. The
      // recursion above is a VERIFICATION mechanism, not a rewriting one:
      // running `node dist/index.js` directly would skip `prestart` (often the
      // build) and drop npm's environment, and `tsx src/cli.ts` outside `npm
      // run` has no `node_modules/.bin` on PATH at all. We verified what
      // `<pm> start` does; `<pm> start` is what we emit.
      start = cmd.start;
      evidence.push("start command from scripts.start");
      if (scripts.prestart || scripts.poststart) {
        evidence.push("start lifecycle hooks verified against the same rules");
      }
      score += 10;
    } else {
      const bin = singleBinPath(pkg);
      if (bin) {
        if (SAFE_RELATIVE_PATH_RE.test(bin) && !escapesCheckout(bin)) {
          // Validated (not merely quoted — see SAFE_RELATIVE_PATH_RE) plain
          // relative path inside the checkout, so it is safe to exec directly.
          const binPath = bin.replace(/^\.\//, "");
          const verdict = verifyEntryPath(binPath, checkout, hasBuildStep);
          if (verdict === "rejected") {
            // Rule C, same reasoning as for scripts.start.
            discarded.push(
              `${manager.pm}: package.json bin is not proven to be checkout code (absent from the listing, not a regular file, or not a checkout-relative path)`,
            );
            continue;
          }
          if (verdict === "unverified") proof = "unverified";
          start = `node ./${bin}`;
          evidence.push("start command from package.json bin entry");
          score += 6;
        } else {
          discarded.push(
            `${manager.pm}: package.json bin is not a plain relative path inside the checkout`,
          );
          continue;
        }
      }
    }
    if (!start) {
      discarded.push(
        `${manager.pm}: package.json has no scripts.start and no single bin entry`,
      );
      continue;
    }

    // --- build command -----------------------------------------------------
    // CheckRecipe.build is required, and for a node project the install IS the
    // minimum build step — so a repo with no build script gets the install
    // alone rather than a no-op like `true`. That keeps the recipe honest
    // (a failing install is still `build_failed`, which is the right blame)
    // and avoids a recipe that pretends to have built something.
    let build = cmd.install;
    if (scripts.build) {
      // Rule B across the whole BUILD lifecycle, not just `build`: `npm run
      // build` runs prebuild and postbuild too, and a `prebuild` of `npx
      // @acme/dist-bundle` fetches the artifact just as effectively. Script
      // references are FOLLOWED (buildFetchesRemotely), so `"build": "npm run
      // bundle"` cannot hide the fetch one hop away.
      const fetching = BUILD_LIFECYCLE.find(
        (hook) =>
          typeof scripts[hook] === "string" &&
          buildFetchesRemotely(scripts[hook], scripts, 0, new Set([hook])),
      );
      if (fetching) {
        discarded.push(
          fetching === "build"
            ? `${manager.pm}: scripts.build fetches a remote artifact; refusing to build from the network`
            : `${manager.pm}: a build lifecycle hook fetches a remote artifact; refusing to build from the network`,
        );
        continue;
      }
      build = `${cmd.install} && ${cmd.run("build")}`;
      evidence.push("build step from scripts.build");
      score += 8;
    } else {
      evidence.push("no build script; install is the build step");
    }

    if (hasMcpSdk) {
      evidence.push("declares an MCP server SDK dependency");
      score += 15;
    }

    evidence.push(
      proof === "verified"
        ? "entry point verified against the checkout file listing"
        : "entry point NOT verified against the checkout; runtime ownership check required",
    );

    out.push({
      recipe: finish({ build, start }, hint, evidence, proof),
      score,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Python (uv only)
// ---------------------------------------------------------------------------

/**
 * Minimal, section-aware pyproject reader. A full TOML parser is not a
 * dependency this module is worth adding: we need exactly two facts (does
 * `[project.scripts]` exist, and what is its first entry name) and one
 * negative signal (`[tool.poetry]`). Anything this misreads yields NO
 * candidate, which is the safe direction for a heuristic.
 */
function pyprojectFacts(raw: string): {
  firstScript: string | null;
  firstScriptTarget: string | null;
  hasPoetry: boolean;
} {
  let section = "";
  let firstScript: string | null = null;
  let firstScriptTarget: string | null = null;
  let hasPoetry = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed === "") continue;
    const header = trimmed.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1].trim();
      if (section === "tool.poetry" || section.startsWith("tool.poetry.")) {
        hasPoetry = true;
      }
      continue;
    }
    if (section === "project.scripts" && firstScript === null) {
      // Both halves matter: the NAME becomes `uv run <name>`, and the TARGET is
      // the only evidence available here that the name resolves to this
      // project's own module rather than to a dependency's console script.
      const entry = trimmed.match(
        /^["']?([A-Za-z0-9._-]+)["']?\s*=\s*["']([^"']*)["']\s*$/,
      );
      if (entry) {
        firstScript = entry[1];
        firstScriptTarget = entry[2];
      }
    }
  }
  return { firstScript, firstScriptTarget, hasPoetry };
}

/**
 * SHAPE of a `[project.scripts]` target: a dotted module path and an attribute,
 * e.g. `acme.server:main`. This is a NECESSARY condition and emphatically not a
 * sufficient one — see `detectPython`. `fastmcp.cli:main` has exactly this
 * shape and names a DEPENDENCY, which is finding 3: `module:attr` is a syntax,
 * and no syntax can tell you who owns the module.
 */
const PY_ENTRY_POINT_RE =
  /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*:[A-Za-z_][A-Za-z0-9_.]*$/;

function detectPython(
  files: DetectionInputs,
  hint: Hint | null,
  discarded: string[],
): Scored[] {
  const raw = withinCap(files.pyprojectToml, DETECTION_MAX_BYTES);
  if (raw === null) {
    if (files.pyprojectToml !== null) {
      discarded.push("pyproject.toml present but exceeds the read cap");
    }
    return [];
  }

  const facts = pyprojectFacts(raw);
  if (files.uvLock === null) {
    // v1 supports exactly one python toolchain. Naming the alternative is the
    // point: the corpus report needs to distinguish "python we chose not to
    // support yet" from "we couldn't tell what this repo is".
    discarded.push(
      facts.hasPoetry
        ? "python: poetry project (v1 supports uv only)"
        : "python: pyproject.toml without uv.lock (v1 supports uv only)",
    );
    return [];
  }
  if (facts.firstScript === null) {
    discarded.push("python: no [project.scripts] entry to start");
    return [];
  }
  // The name is spliced into `uv run <name>`; require it to look like a script
  // name and not like a flag or an option value.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(facts.firstScript)) {
    discarded.push("python: [project.scripts] name is not a plain script name");
    return [];
  }
  if (
    facts.firstScriptTarget === null ||
    !PY_ENTRY_POINT_RE.test(facts.firstScriptTarget)
  ) {
    discarded.push(
      "python: [project.scripts] entry point is not a local module reference",
    );
    return [];
  }

  // Rule C, and for python it is MANDATORY rather than an extra check.
  //
  // `uv sync` installs this project AND its dependencies into one environment,
  // and `[project.scripts]` may legally point at either. `fastmcp.cli:main`
  // parses exactly like `acme.server:main`; the only difference is who owns the
  // module, and that fact lives in the checkout, not in the pyproject. Without
  // a file listing we have no way to tell them apart, so we suppress — a
  // resolver miss instead of `uv run acme` quietly starting fastmcp and
  // greening a check on a dependency's code.
  const checkout = checkoutFiles(files.repoFiles);
  if (!checkout) {
    discarded.push(
      "python: cannot verify the [project.scripts] target is checkout code (no file listing available)",
    );
    return [];
  }
  const module = facts.firstScriptTarget.split(":")[0];
  // `=== "file"`, not "present": a `src/acme/server.py` that is a SYMLINK into
  // a dependency's site-packages is the python spelling of the same lie, and
  // the listing now carries enough to refuse it.
  const owned = pythonModuleFiles(module).some(
    (path) => checkout.get(path) === "file",
  );
  if (!owned) {
    discarded.push(
      "python: the [project.scripts] target resolves to a dependency module, not to checkout source",
    );
    return [];
  }

  return [
    {
      recipe: finish(
        {
          // `--frozen` for the same reason as the node frozen installs: the
          // lockfile is the contract, and drifting from it silently would test
          // dependencies the author never resolved.
          build: "uv sync --frozen",
          start: `uv run ${facts.firstScript}`,
        },
        hint,
        [
          "pyproject.toml + uv.lock",
          "start command from [project.scripts]",
          "entry module verified against the checkout file listing",
        ],
        // Python only ever emits when the module was found as a regular file in
        // the listing — the no-listing and not-found paths both returned above
        // — so this arm is proven by construction.
        "verified",
      ),
      score: 25,
    },
  ];
}

// ---------------------------------------------------------------------------

function finish(
  commands: { build: string; start: string },
  hint: Hint | null,
  evidence: string[],
  ownershipProof: OwnershipProof,
): ResolvedRecipe {
  const recipe: CheckRecipe = {
    build: commands.build,
    start: commands.start,
    port: hint?.port ?? DEFAULT_PORT,
    mcpPath: hint?.path ?? DEFAULT_MCP_PATH,
  };
  const lines = [...evidence];
  if (hint && (hint.port !== undefined || hint.path !== undefined)) {
    // Names the SOURCE, never the value: `hint.path` is untrusted PR content
    // and evidence is rendered into GitHub check output. The port is echoed
    // because it is an integer we validated, and it is the one number an
    // author debugging a `server_unhealthy` result actually needs.
    const parts: string[] = [];
    if (hint.port !== undefined) parts.push(`port ${recipe.port}`);
    if (hint.path !== undefined) parts.push("path");
    lines.push(`${parts.join(" and ")} from ${hint.source}`);
  }
  return { ...recipe, rung: "detected", ownershipProof, evidence: lines };
}

/**
 * Detect candidate recipes for a checkout, best-first.
 *
 * Returns `[]` when nothing is detectable — an empty array is a normal
 * outcome, not an error (heuristic rung). Reasons for rejected candidates are
 * not part of the recipe; use `detectCandidatesWithReasons` when you need them
 * (the corpus harness does, and R4's `recipe_unresolvable` output will).
 */
export function detectCandidates(files: DetectionInputs): ResolvedRecipe[] {
  return detectCandidatesWithReasons(files).candidates;
}

export function detectCandidatesWithReasons(files: DetectionInputs): {
  candidates: ResolvedRecipe[];
  /** Why plausible candidates were rejected. Constant strings only. */
  discarded: string[];
} {
  const discarded: string[] = [];
  // Hints are computed once and shared: they describe the SERVER, not the
  // toolchain, so every candidate for this checkout gets the same port/path.
  const hint = hintFromServerJson(files.serverJson) ?? hintFromReadme(files.readme);

  const scored = [
    ...detectNode(files, hint, discarded),
    ...detectPython(files, hint, discarded),
  ];

  // Stable, best-first. `sort` is stable in modern V8, so equal scores keep
  // detection order (node before python), which is deterministic — R3 caches
  // these by evidence hash and a reshuffle would look like a cache miss.
  scored.sort((a, b) => b.score - a.score);

  return { candidates: scored.map((entry) => entry.recipe), discarded };
}
