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
import type { ResolvedRecipe } from "./types";

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
   * relative paths (POSIX separators, no leading `./`) of files present in the
   * checkout. This is a FILE LISTING, not file contents — it does not join the
   * R3 recipe cache key the way the parsed fields above do, because it is
   * derived from the same commit those are read at.
   *
   * When present, a candidate's entry point must be findable in it. When
   * ABSENT, node falls back to the strict syntactic path rules (relative, no
   * `node_modules`, no `../`, safe charset) and python `[project.scripts]`
   * candidates are suppressed outright — see `detectPython`.
   *
   * Populated today by `scripts/resolver-corpus.ts` (it has the clone on disk).
   * A3 populates it from the sandbox, where the checkout is likewise on disk;
   * until then, production callers pass nothing and get the conservative path.
   */
  repoFiles?: string[];
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
 * Normalize the caller's listing into a lookup set. Leading `./` is stripped
 * and separators are POSIX, so `./dist/cli.js` and `dist/cli.js` are the same
 * file — a caller assembling this from `git ls-files` or a directory walk
 * should not have to know which spelling we compare against.
 */
function checkoutFiles(repoFiles: string[] | undefined): Set<string> | null {
  // An EMPTY listing means "we could not list the checkout", not "the checkout
  // is empty" — no repo we can detect has zero files. Treating it as absent
  // keeps the reasons honest (a caller whose `git ls-files` failed gets the
  // no-listing reason, not "your entry point is a dependency").
  if (!repoFiles || repoFiles.length === 0) return null;
  const out = new Set<string>();
  for (const entry of repoFiles) {
    if (typeof entry !== "string" || entry === "") continue;
    out.add(entry.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return out;
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
 * Is this entry path established as checkout code?
 *
 * Present in the listing → yes, directly. Absent but the candidate has a BUILD
 * step → also yes: `node dist/index.js` after `npm run build` is the single
 * most common shape in the ecosystem, and `dist/` is a build OUTPUT — it is by
 * definition not in the checkout, and it is by definition produced from the
 * checkout. Requiring it to be committed would suppress nearly every node repo
 * for no safety gain, since a relative path that no launcher and no shell
 * expansion produced can only resolve inside the checkout.
 *
 * Absent AND no build step → suppressed. Nothing in the repo produces that
 * file, so whatever the command finds at runtime is not this PR's code (and if
 * it finds nothing, the check would fail and blame the author for our guess).
 */
function entryEstablished(
  path: string,
  files: Set<string>,
  hasBuildStep: boolean,
): boolean {
  return files.has(path) || hasBuildStep;
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

    // --- start command -----------------------------------------------------
    let start: string | null = null;
    if (scripts.start) {
      if (isRemoteInvocation(scripts.start)) {
        // The disguised-launcher case. Do not fall back to `bin` here: a repo
        // whose own start script fetches the published package is telling us
        // its checkout is not the thing under test.
        discarded.push(
          `${manager.pm}: scripts.start launches a published package or remote URL, not the checkout`,
        );
        continue;
      }
      if (isUnprovableShell(scripts.start)) {
        // Rule A. `node "$(npm root)"/@acme/server/bin.js` and every other
        // shell-computed entry point lands here: we cannot see what it runs, so
        // we cannot claim it runs the checkout, so we do not emit it.
        discarded.push(
          `${manager.pm}: scripts.start uses shell expansion or chaining, so what it runs cannot be established`,
        );
        continue;
      }
      if (escapesCheckout(scripts.start)) {
        // Same verdict, nearer miss: `node node_modules/@acme/server/bin.js`
        // starts the installed dependency. Suppressing beats emitting — a
        // missed candidate is a resolver miss we can measure, a false green is
        // the failure this whole module exists to prevent.
        discarded.push(
          `${manager.pm}: scripts.start runs an installed dependency or a path outside the checkout`,
        );
        continue;
      }
      if (checkout) {
        // Rule C. Every file the start command names must be checkout code or
        // the output of the checkout's own build.
        const unestablished = entryPaths(scripts.start).filter(
          (path) => !entryEstablished(path, checkout, hasBuildStep),
        );
        if (unestablished.length > 0) {
          discarded.push(
            `${manager.pm}: scripts.start runs a file that is not in the checkout and no build step produces it`,
          );
          continue;
        }
      }
      start = cmd.start;
      evidence.push("start command from scripts.start");
      score += 10;
    } else {
      const bin = singleBinPath(pkg);
      if (bin) {
        if (SAFE_RELATIVE_PATH_RE.test(bin) && !escapesCheckout(bin)) {
          // Validated (not merely quoted — see SAFE_RELATIVE_PATH_RE) plain
          // relative path inside the checkout, so it is safe to exec directly.
          const binPath = bin.replace(/^\.\//, "");
          if (checkout && !entryEstablished(binPath, checkout, hasBuildStep)) {
            // Rule C, same reasoning as for scripts.start.
            discarded.push(
              `${manager.pm}: package.json bin is not in the checkout and no build step produces it`,
            );
            continue;
          }
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
      if (isRemoteInvocation(scripts.build)) {
        discarded.push(
          `${manager.pm}: scripts.build fetches a remote artifact; refusing to build from the network`,
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

    out.push({
      recipe: finish({ build, start }, hint, evidence),
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
  const owned = pythonModuleFiles(module).some((path) => checkout.has(path));
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
  return { ...recipe, rung: "detected", evidence: lines };
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
