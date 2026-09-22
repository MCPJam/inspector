/**
 * Dev-only corpus harness for the recipe resolver's detection rung (R2).
 *
 * NOT IN CI, on purpose: it clones ~55 third-party repos over the network, so
 * it is a decision instrument an engineer runs by hand, not a gate. Run it:
 *
 *   npx tsx scripts/resolver-corpus.ts               # from mcpjam-inspector/
 *   npx tsx scripts/resolver-corpus.ts --json out.json
 *   npx tsx scripts/resolver-corpus.ts --limit 10 --keep
 *
 * THE QUESTION IT ANSWERS is not "what fraction of MCP repos can we run" —
 * that number is dominated by stdio-only servers, which detection is not
 * supposed to fix (a stdio bridge is a separate, out-of-scope feature). It is
 * RECALL OVER HTTP-CAPABLE REPOS:
 *
 *   recall = resolved / (resolved + detector_miss)
 *
 * Poor recall means the heuristics are the bottleneck and the agentic rung
 * (R5) deserves priority. Good recall means the bottleneck is transport, and
 * R5 would be optimizing the wrong end.
 *
 * WHAT IT CANNOT KNOW: it never builds and never probes. `resolved` therefore
 * means "we produced a candidate that runs the checkout over HTTP", not "that
 * candidate works". The `build_miss` (candidate built wrong) and `probe_miss`
 * (built but never spoke MCP) buckets exist in the taxonomy and are reported
 * as deferred — only A3's sandbox e2e can populate them. Read `resolved` as an
 * UPPER BOUND on real recall.
 *
 * The manifest is pinned by sha (resolver-corpus.manifest.json) so a re-run
 * after a detector change measures the detector, not GitHub's default branch.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listRepoFiles,
  RecipeResolutionError,
  resolveRecipeLadder,
  type DetectionInputs,
  type OwnershipProof,
  type ResolvedRecipe,
} from "../server/services/github-checks/resolver";

type ManifestEntry = { repo: string; sha: string };

type Category =
  | "resolved"
  | "unsupported_transport"
  | "detector_miss"
  | "infra_error";

type Row = {
  repo: string;
  sha: string;
  category: Category;
  /** Present for `resolved`. */
  candidates?: {
    build: string;
    start: string;
    port: number;
    mcpPath: string;
    ownershipProof: OwnershipProof;
  }[];
  /**
   * Present for `resolved`: the BEST candidate's proof. This is the number that
   * says how much of recall A3's runtime ownership check is carrying — an
   * 'unverified' row resolved on a plausibility argument, not on evidence.
   */
  ownershipProof?: OwnershipProof;
  evidence?: string[];
  /** Present for `detector_miss` / `unsupported_transport`. */
  reasons?: string[];
  signals: string[];
};

const MANIFEST = join(import.meta.dirname, "resolver-corpus.manifest.json");

// Mirrors the in-sandbox byte cap R4 will read with (`head -c`): reading a
// 200MB lockfile into this process would be a self-inflicted outage.
const READ_CAP_BYTES = 512 * 1024;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function readCapped(dir: string, relative: string): string | null {
  const path = join(dir, relative);
  if (!existsSync(path)) return null;
  // openSync + readSync into a fixed buffer, NOT readFileSync().subarray():
  // the latter materializes the whole file first, so a 200MB lockfile would be
  // fully resident before the cap ever applied — which is the outage this cap
  // exists to prevent. This is `head -c`, the same thing R4 does in-sandbox.
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(READ_CAP_BYTES);
    const bytes = readSync(fd, buffer, 0, READ_CAP_BYTES, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Shallow-clone at the pinned sha. `--depth 1` on a bare init + fetch is the
 * only way to fetch ONE commit by sha: `git clone --depth 1` can only take a
 * ref, and cloning full history for 55 repos is minutes of pointless IO.
 */
function cloneAt(repo: string, sha: string, dir: string): void {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe", timeout: 180_000 });
  run(["init", "--quiet"]);
  run(["remote", "add", "origin", `https://github.com/${repo}.git`]);
  run(["fetch", "--quiet", "--depth", "1", "origin", sha]);
  run(["checkout", "--quiet", "FETCH_HEAD"]);
}

function readInputs(dir: string): DetectionInputs {
  return {
    repoFiles: listRepoFiles(dir),
    packageJson: readCapped(dir, "package.json"),
    packageLockJson: readCapped(dir, "package-lock.json"),
    pnpmLockYaml: readCapped(dir, "pnpm-lock.yaml"),
    yarnLock: readCapped(dir, "yarn.lock"),
    pyprojectToml: readCapped(dir, "pyproject.toml"),
    uvLock: readCapped(dir, "uv.lock"),
    serverJson: readCapped(dir, "server.json"),
    readme: readCapped(dir, "README.md") ?? readCapped(dir, "readme.md"),
  };
}

/**
 * Does this repo appear to serve MCP over HTTP at all?
 *
 * This is the classifier that separates "we failed" from "not our problem", so
 * it is deliberately GENEROUS toward HTTP: over-counting HTTP repos makes
 * recall look WORSE than it is, which is the safe direction for a number that
 * decides whether to invest in R5.
 *
 * These are corpus-report signals only — nothing here feeds the detector.
 */
function httpSignals(files: DetectionInputs, dir: string): string[] {
  const signals: string[] = [];
  const haystack = [
    files.readme ?? "",
    files.serverJson ?? "",
    files.packageJson ?? "",
    files.pyprojectToml ?? "",
    // A source scan is worth one grep: many servers document only the stdio
    // config in the README while shipping an HTTP mode behind a flag.
    grepSources(dir),
  ].join("\n");

  if (/streamable[-_ ]?http/i.test(haystack)) signals.push("streamable-http");
  if (/StreamableHTTPServerTransport|streamable_http_app|http_app\(|SSEServerTransport/.test(haystack)) {
    signals.push("http-transport-api");
  }
  if (/--(port|http|transport[= ]http)/.test(haystack)) signals.push("http-cli-flag");
  if (/\bexpress\(\)|createServer\(|FastAPI\(|uvicorn|starlette/i.test(haystack)) {
    signals.push("http-framework");
  }
  if (/https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[a-z]/i.test(haystack)) {
    signals.push("localhost-url");
  }
  return signals;
}

/**
 * Bound on the grep haystack: signal regexes need text, not a whole codebase.
 *
 * Raised with SOURCE_SIGNAL_ANCHORS. Truncation is BLIND to which signal a line
 * carries, so a cap that the broadened anchor set can actually reach would drop
 * `streamable` lines that happen to sort after a wall of `localhost` ones — a
 * silent, file-order-dependent loss of exactly the evidence this scan exists to
 * find. 8MB is comfortably past the total source size of every repo in the
 * pinned manifest, so in practice nothing is truncated at all.
 */
const GREP_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Coarse anchors for EVERY signal `httpSignals()` classifies on, not just the
 * transport-specific ones.
 *
 * This list is a PREFILTER, and the correspondence to `httpSignals()` is the
 * whole point: grep decides which LINES the classifier gets to see, so any
 * classifier pattern with no anchor here is a pattern that can only ever fire
 * on README/manifest text. That is how `express()`, `FastAPI()`,
 * `createServer()`, localhost URLs and the HTTP CLI flags were invisible in
 * source — and a repo whose only HTTP evidence is source-level was then filed
 * `unsupported_transport`, dropping OUT of the recall denominator and making
 * recall look better than it is.
 *
 * Anchors are deliberately shorter and looser than the classifier regexes
 * (`express` for `\bexpress\(\)`, `localhost` for the full URL form): grep only
 * has to deliver the line, and `httpSignals()` still makes the actual call. In
 * BRE, `(` and `)` are literal, so these are read as written.
 */
const SOURCE_SIGNAL_ANCHORS = [
  // streamable-http, in every spelling httpSignals accepts
  "streamable",
  // http-transport-api
  "SSEServerTransport",
  "http_app",
  // http-cli-flag
  "--port",
  "--http",
  "--transport",
  // http-framework
  "express",
  "createServer",
  "FastAPI",
  "uvicorn",
  "starlette",
  // localhost-url
  "localhost",
  "127.0.0.1",
];

function grepSources(dir: string): string {
  // `-h`, never `-l`: `-l` prints FILE NAMES, and the signal regexes in
  // httpSignals() would then run over a list of paths, so source-only HTTP
  // evidence contributed nothing and HTTP-capable repos were misfiled as
  // `unsupported_transport`. `-h` prints the matching LINES without the
  // filename prefix, which is what those regexes need — `-o` would trim the
  // match down to the `-e` token and hide longer forms like
  // `StreamableHTTPServerTransport`. `-i` because several classifier regexes
  // are case-insensitive and grep here only decides candidacy. Output is
  // bounded twice: maxBuffer here, and GREP_MAX_BYTES on the way out.
  try {
    return execFileSync(
      "grep",
      [
        "-rIhi",
        "--include=*.ts",
        "--include=*.js",
        "--include=*.py",
        "--include=*.go",
        ...SOURCE_SIGNAL_ANCHORS.flatMap((anchor) => ["-e", anchor]),
        ".",
      ],
      {
        cwd: dir,
        stdio: "pipe",
        timeout: 60_000,
        // Raised with the anchor list: `localhost` and `--port` match far more
        // lines than `StreamableHTTP` did, and an execFileSync maxBuffer
        // overflow THROWS — which the catch below would turn into "no signal
        // at all", silently undoing this fix on exactly the repos with the most
        // HTTP evidence. GREP_MAX_BYTES still bounds what the classifier reads.
        maxBuffer: 64 * 1024 * 1024,
      },
    )
      .subarray(0, GREP_MAX_BYTES)
      .toString("utf8");
  } catch {
    // grep exits 1 when nothing matched — that is a normal answer, not an
    // error. maxBuffer overflow lands here too; an oversized match set is
    // already an HTTP signal we will have caught from the README in practice,
    // and treating it as "no signal" biases toward `detector_miss`, the
    // pessimistic direction for recall.
    return "";
  }
}

function classify(repo: string, sha: string, dir: string): Row {
  const files = readInputs(dir);
  const signals = httpSignals(files, dir);

  let candidates: ResolvedRecipe[] = [];
  let reasons: string[] = [];
  try {
    const resolution = resolveRecipeLadder({
      repoFullName: repo,
      // The corpus measures DETECTION. Third-party repos have no mcpjam.yaml
      // and no operator override, so the ladder always reaches rung 2; passing
      // null keeps that explicit rather than accidental.
      mcpjamYaml: null,
      detection: files,
    });
    candidates =
      resolution.kind === "candidates" ? resolution.candidates : [resolution.recipe];
  } catch (err) {
    if (!(err instanceof RecipeResolutionError)) throw err;
    reasons = (err.detailsMarkdown ?? "")
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2));
  }

  // TRANSPORT IS CHECKED FIRST, even when detection produced a candidate. A
  // stdio-only repo with a package.json and a start script yields a perfectly
  // good candidate — for a server this harness cannot probe over HTTP. Calling
  // that `resolved` would put an out-of-scope repo in the recall NUMERATOR
  // while the same repo lands outside the denominator whenever detection
  // misses, inflating the one number this harness exists to produce.
  if (signals.length === 0) {
    return {
      repo,
      sha,
      category: "unsupported_transport",
      reasons:
        candidates.length > 0
          ? ["candidate detected, but no HTTP transport evidence in the repo"]
          : reasons,
      signals,
    };
  }

  if (candidates.length > 0) {
    return {
      repo,
      sha,
      category: "resolved",
      candidates: candidates.map((c) => ({
        build: c.build,
        start: c.start,
        port: c.port,
        mcpPath: c.mcpPath,
        ownershipProof: c.ownershipProof,
      })),
      ownershipProof: candidates[0].ownershipProof,
      evidence: candidates[0].evidence,
      signals,
    };
  }

  // HTTP evidence present but no candidate: this one is ours to fix.
  return { repo, sha, category: "detector_miss", reasons, signals };
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    repos: ManifestEntry[];
  };
  // `--limit` last on the command line makes arg() undefined, and Number(
  // undefined) is NaN — slice(0, NaN) is empty, and report() would then divide
  // by zero and print NaN% for every category. Anything not a positive integer
  // means "no limit".
  const requested = Number(arg("limit"));
  const limit =
    Number.isInteger(requested) && requested > 0 ? requested : manifest.repos.length;
  const entries = manifest.repos.slice(0, limit);
  const keep = hasFlag("keep");

  const rows: Row[] = [];
  for (const [index, entry] of entries.entries()) {
    const label = `[${index + 1}/${entries.length}] ${entry.repo}`;
    const dir = mkdtempSync(join(tmpdir(), "resolver-corpus-"));
    try {
      cloneAt(entry.repo, entry.sha, dir);
      const row = classify(entry.repo, entry.sha, dir);
      rows.push(row);
      console.error(`${label}: ${row.category}`);
    } catch (err) {
      // Clone/read trouble is OUR infrastructure failing, never a detector
      // verdict — the same separation A3 enforces between resolver misses and
      // sandbox infra errors.
      rows.push({
        repo: entry.repo,
        sha: entry.sha,
        category: "infra_error",
        reasons: [err instanceof Error ? err.message.slice(0, 200) : String(err)],
        signals: [],
      });
      console.error(`${label}: infra_error`);
    } finally {
      if (!keep) rmSync(dir, { recursive: true, force: true });
    }
  }

  report(rows);

  const out = arg("json");
  if (out) {
    writeFileSync(out, `${JSON.stringify({ rows }, null, 2)}\n`);
    console.log(`\nper-repo detail written to ${out}`);
  }
}

function report(rows: Row[]): void {
  const counts = new Map<Category, number>();
  for (const row of rows) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);

  const total = rows.length;
  const order: Category[] = [
    "resolved",
    "unsupported_transport",
    "detector_miss",
    "infra_error",
  ];
  console.log(`\n${"category".padEnd(24)}${"n".padStart(5)}${"share".padStart(9)}`);
  console.log("-".repeat(38));
  for (const category of order) {
    const n = counts.get(category) ?? 0;
    const share = total === 0 ? "n/a" : `${((n / total) * 100).toFixed(1)}%`;
    console.log(`${category.padEnd(24)}${String(n).padStart(5)}${share.padStart(9)}`);
  }
  console.log(`${"build_miss (deferred)".padEnd(24)}${"—".padStart(5)}${"—".padStart(9)}`);
  console.log(`${"probe_miss (deferred)".padEnd(24)}${"—".padStart(5)}${"—".padStart(9)}`);
  console.log("-".repeat(38));
  console.log(`${"total".padEnd(24)}${String(total).padStart(5)}`);

  const resolved = counts.get("resolved") ?? 0;
  const miss = counts.get("detector_miss") ?? 0;
  const httpCapable = resolved + miss;
  console.log(
    `\nRECALL over HTTP-capable repos: ${resolved}/${httpCapable} = ` +
      (httpCapable === 0 ? "n/a" : `${((resolved / httpCapable) * 100).toFixed(1)}%`),
  );
  console.log(
    "  (upper bound — no build, no probe; build_miss/probe_miss land in A3's e2e)",
  );

  // The other number this harness now owes: static analysis cannot establish
  // that a build OUTPUT is checkout-derived, so those candidates ship marked
  // 'unverified' and A3's runtime ownership check is what actually settles
  // them. This split is how much load that check carries.
  const resolvedRows = rows.filter((r) => r.category === "resolved");
  const verified = resolvedRows.filter((r) => r.ownershipProof === "verified").length;
  const unverified = resolvedRows.length - verified;
  console.log(
    `\nOWNERSHIP PROOF among resolved: verified ${verified}, unverified ${unverified}` +
      (resolvedRows.length === 0
        ? ""
        : ` (${((unverified / resolvedRows.length) * 100).toFixed(1)}% need A3's runtime check)`),
  );

  if (miss > 0) {
    console.log("\ndetector_miss detail:");
    for (const row of rows.filter((r) => r.category === "detector_miss")) {
      console.log(`  ${row.repo}`);
      for (const reason of row.reasons ?? []) console.log(`    - ${reason}`);
      if ((row.reasons ?? []).length === 0) console.log("    - no supported ecosystem files");
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
