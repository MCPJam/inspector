#!/usr/bin/env node
/**
 * Credential leak monitor: counts PostHog events and Sentry events from the
 * last N hours (default 24) that still carry an UNREDACTED credential in a
 * URL, grouped by credential-registry route id.
 *
 *   node ops/credential-leak-monitor/run.mts --dry-run   # print the queries
 *   node ops/credential-leak-monitor/run.mts             # run them
 *
 * Options: --dry-run, --hours=<n>, --only=posthog|sentry, --self-test.
 *
 * `--self-test` sends PostHog a query over LITERAL sample URLs (no table,
 * no event data) and checks that ClickHouse's RE2 classifies every sample
 * the way the JavaScript patterns do. Run it after changing the patterns.
 *
 * Environment (never pass these on the command line):
 *   POSTHOG_PERSONAL_API_KEY  PostHog personal API key with `query:read`
 *   POSTHOG_PROJECT_ID        PostHog project id
 *   POSTHOG_HOST              default https://us.posthog.com
 *   SENTRY_AUTH_TOKEN         Sentry token with `event:read` (org:read)
 *   SENTRY_ORG                Sentry organization slug
 *   SENTRY_BASE_URL           default https://sentry.io
 *   SENTRY_DATASET            Discover dataset, default `discover`
 *
 * Exit codes: 0 clean, 1 leak found, 2 the monitor could not look (missing
 * configuration, an API error). A blind monitor must not read as a clean one.
 *
 * Output never contains a matched URL or property value: a hit IS a
 * credential, and the report goes to a chat channel. It contains route ids,
 * counts and (for Sentry) event ids, which are enough to find and delete the
 * events in the vendor's UI.
 *
 * Node 22.18+ runs this file directly (built-in type stripping). Node 22.6 to
 * 22.17 needs `--experimental-strip-types`.
 */
import { appendFileSync } from "node:fs";
import {
  buildHogqlQuery,
  buildHogqlSelfTest,
  buildLeakPatterns,
  buildSentryQueries,
  classifyLeak,
  SENTRY_URL_FIELDS,
  toRegExp,
} from "./patterns.mts";
import { allSamples } from "./samples.mts";

interface Args {
  dryRun: boolean;
  selfTest: boolean;
  hours: number;
  only: "posthog" | "sentry" | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false, selfTest: false, hours: 24, only: null };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--self-test") args.selfTest = true;
    else if (arg.startsWith("--hours=")) args.hours = Number(arg.slice(8));
    else if (arg === "--only=posthog" || arg === "--only=sentry") {
      args.only = arg.slice(7) as Args["only"];
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: node ops/credential-leak-monitor/run.mts [--dry-run] [--self-test] [--hours=24] [--only=posthog|sentry]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!Number.isInteger(args.hours) || args.hours <= 0 || args.hours > 744) {
    throw new Error("--hours must be an integer between 1 and 744");
  }
  return args;
}

interface SinkResult {
  sink: "PostHog" | "Sentry";
  status: "clean" | "leak" | "blind";
  /** route id → events */
  counts: Map<string, number>;
  /** Free-form lines for the report. Never a URL. */
  notes: string[];
}

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

/** Error text with anything after a `?` (a query string) cut off. */
function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\?\S*/g, "?…").slice(0, 300);
}

// ── PostHog ────────────────────────────────────────────────────────────

async function runPosthog(hours: number): Promise<SinkResult> {
  const result: SinkResult = {
    sink: "PostHog",
    status: "blind",
    counts: new Map(),
    notes: [],
  };
  const key = env("POSTHOG_PERSONAL_API_KEY");
  const projectId = env("POSTHOG_PROJECT_ID");
  const host = (env("POSTHOG_HOST") ?? "https://us.posthog.com").replace(
    /\/+$/,
    "",
  );
  if (!key || !projectId) {
    result.notes.push(
      "POSTHOG_PERSONAL_API_KEY or POSTHOG_PROJECT_ID is not set; PostHog was not checked.",
    );
    return result;
  }
  try {
    const response = await fetch(
      `${host}/api/projects/${encodeURIComponent(projectId)}/query/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: { kind: "HogQLQuery", query: buildHogqlQuery({ hours }) },
          name: "credential-leak-monitor",
        }),
        signal: AbortSignal.timeout(300_000),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      result.notes.push(
        `PostHog query failed: HTTP ${response.status} ${text.slice(0, 300)}`,
      );
      return result;
    }
    const body = JSON.parse(text) as {
      results?: unknown[][];
      columns?: string[];
    };
    const columns = body.columns ?? [
      "route_id",
      "property",
      "platform",
      "version",
      "events",
    ];
    const at = (name: string) => columns.indexOf(name);
    for (const row of body.results ?? []) {
      const route = String(row[at("route_id")]);
      const events = Number(row[at("events")]);
      result.counts.set(route, (result.counts.get(route) ?? 0) + events);
      const platform = String(row[at("platform")] ?? "") || "?";
      const version = String(row[at("version")] ?? "") || "?";
      result.notes.push(
        `${route} in ${String(row[at("property")])} (${platform} ${version}): ${events}`,
      );
    }
    result.status = result.counts.size > 0 ? "leak" : "clean";
  } catch (error) {
    result.notes.push(`PostHog query failed: ${safeError(error)}`);
  }
  return result;
}

// ── Sentry ─────────────────────────────────────────────────────────────

/** Pages per Discover search. 100 events per page. */
const SENTRY_MAX_PAGES = 20;

function nextCursor(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part) || !/results="true"/.test(part)) continue;
    const cursor = /cursor="([^"]+)"/.exec(part)?.[1];
    if (cursor) return cursor;
  }
  return null;
}

async function runSentry(hours: number): Promise<SinkResult> {
  const result: SinkResult = {
    sink: "Sentry",
    status: "blind",
    counts: new Map(),
    notes: [],
  };
  const token = env("SENTRY_AUTH_TOKEN");
  const org = env("SENTRY_ORG");
  const base = (env("SENTRY_BASE_URL") ?? "https://sentry.io").replace(
    /\/+$/,
    "",
  );
  const dataset = env("SENTRY_DATASET") ?? "discover";
  if (!token || !org) {
    result.notes.push(
      "SENTRY_AUTH_TOKEN or SENTRY_ORG is not set; Sentry was not checked.",
    );
    return result;
  }
  const patterns = buildLeakPatterns();
  const seen = new Set<string>();
  let truncated = false;
  const leakedIds = new Map<string, string[]>();
  try {
    for (const search of buildSentryQueries()) {
      let cursor: string | null = null;
      for (let page = 0; page < SENTRY_MAX_PAGES; page++) {
        const params = new URLSearchParams({
          query: search.query,
          statsPeriod: `${hours}h`,
          per_page: "100",
          dataset,
        });
        for (const field of ["id", "project", ...SENTRY_URL_FIELDS]) {
          params.append("field", field);
        }
        if (cursor) params.set("cursor", cursor);
        const response = await fetch(
          `${base}/api/0/organizations/${encodeURIComponent(org)}/events/?${params}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(60_000),
          },
        );
        if (!response.ok) {
          const text = await response.text();
          result.notes.push(
            `Sentry search "${search.name}" failed: HTTP ${response.status} ${text.slice(0, 300)}`,
          );
          return result;
        }
        const body = (await response.json()) as {
          data?: Record<string, unknown>[];
        };
        for (const row of body.data ?? []) {
          const id = String(row.id ?? "");
          if (!id || seen.has(id)) continue;
          seen.add(id);
          for (const field of SENTRY_URL_FIELDS) {
            const route = classifyLeak(String(row[field] ?? ""), patterns);
            if (!route) continue;
            result.counts.set(route, (result.counts.get(route) ?? 0) + 1);
            const ids = leakedIds.get(route) ?? [];
            if (ids.length < 10) {
              ids.push(`${String(row.project ?? "?")}:${id} (${field})`);
            }
            leakedIds.set(route, ids);
            break;
          }
        }
        cursor = nextCursor(response.headers.get("link"));
        if (!cursor) break;
        if (page === SENTRY_MAX_PAGES - 1) {
          // Events past the cap were never looked at. A leak among them would
          // otherwise read as "clean"; a monitor that could not look is blind.
          truncated = true;
          result.notes.push(
            `Sentry search "${search.name}" hit the ${SENTRY_MAX_PAGES}-page cap; events past it were not examined.`,
          );
        }
      }
    }
    for (const [route, ids] of leakedIds) {
      result.notes.push(`${route}: events ${ids.join(", ")}`);
    }
    result.notes.push(`${seen.size} candidate events examined.`);
    // A leak found is a leak whatever else happened; otherwise a capped
    // search cannot vouch for what it did not read.
    result.status =
      result.counts.size > 0 ? "leak" : truncated ? "blind" : "clean";
  } catch (error) {
    result.notes.push(`Sentry search failed: ${safeError(error)}`);
  }
  return result;
}

// ── Self-test ──────────────────────────────────────────────────────────

/** Whether ClickHouse (RE2) and JavaScript classify the samples the same. */
async function selfTest(): Promise<number> {
  const key = env("POSTHOG_PERSONAL_API_KEY");
  const projectId = env("POSTHOG_PROJECT_ID");
  const host = (env("POSTHOG_HOST") ?? "https://us.posthog.com").replace(
    /\/+$/,
    "",
  );
  if (!key || !projectId) {
    process.stderr.write(
      "--self-test needs POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID\n",
    );
    return 2;
  }
  const samples = allSamples().filter((sample) => sample.value !== "");
  const response = await fetch(
    `${host}/api/projects/${encodeURIComponent(projectId)}/query/`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: {
          kind: "HogQLQuery",
          query: buildHogqlSelfTest(samples.map((sample) => sample.value)),
        },
        name: "credential-leak-monitor-self-test",
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    process.stderr.write(
      `self-test query failed: HTTP ${response.status} ${text.slice(0, 500)}\n`,
    );
    return 2;
  }
  const hits = (JSON.parse(text) as { results?: unknown[][] })
    .results?.[0]?.[0];
  if (!Array.isArray(hits) || hits.length !== samples.length) {
    process.stderr.write("self-test: unexpected result shape\n");
    return 2;
  }
  let failures = 0;
  samples.forEach((sample, index) => {
    const re2 = String(hits[index] ?? "").split("|")[0] || null;
    const js = classifyLeak(sample.value);
    if (re2 !== js || js !== sample.expected) {
      failures++;
      process.stdout.write(
        `MISMATCH sample ${index}: expected ${sample.expected}, js ${js}, re2 ${re2}\n`,
      );
    }
  });
  process.stdout.write(
    `self-test: ${samples.length - failures}/${samples.length} samples agree\n`,
  );
  return failures === 0 ? 0 : 1;
}

// ── Report ─────────────────────────────────────────────────────────────

function report(results: readonly SinkResult[], hours: number): string {
  const lines: string[] = [`Credential leak monitor, last ${hours}h`, ""];
  for (const result of results) {
    const total = [...result.counts.values()].reduce((a, b) => a + b, 0);
    const headline =
      result.status === "clean"
        ? "clean"
        : result.status === "leak"
          ? `${total} event(s) with an unredacted credential`
          : "NOT CHECKED";
    lines.push(`${result.sink}: ${headline}`);
    for (const [route, count] of [...result.counts].sort(
      (a, b) => b[1] - a[1],
    )) {
      lines.push(`  - ${route}: ${count}`);
    }
    for (const note of result.notes) lines.push(`    ${note}`);
  }
  return lines.join("\n");
}

function printDryRun(hours: number): void {
  const out: string[] = [];
  out.push("# Patterns (route id, flags, source)", "");
  for (const pattern of buildLeakPatterns()) {
    // Constructing each one also proves it is a valid JavaScript RegExp.
    toRegExp(pattern);
    const reserved = pattern.reserved.length
      ? ` reserved=${pattern.reserved.join(",")}`
      : "";
    out.push(
      `${pattern.id} [${pattern.caseInsensitive ? "i" : "-"}]${reserved}`,
      `  ${pattern.source}`,
    );
  }
  out.push(
    "",
    "# PostHog HogQL (generated from mcpjam-inspector/shared/credential-urls.ts; do not edit by hand)",
    "",
    buildHogqlQuery({ hours }),
    "",
  );
  out.push(
    `# Sentry Discover (statsPeriod=${hours}h, fields: id, project, ${SENTRY_URL_FIELDS.join(", ")})`,
    "",
  );
  for (const search of buildSentryQueries()) {
    out.push(`## ${search.name}`, search.query, "");
  }
  process.stdout.write(`${out.join("\n")}\n`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) {
    printDryRun(args.hours);
    return 0;
  }
  if (args.selfTest) return selfTest();
  const results: SinkResult[] = [];
  if (args.only !== "sentry") results.push(await runPosthog(args.hours));
  if (args.only !== "posthog") results.push(await runSentry(args.hours));
  const text = report(results, args.hours);
  process.stdout.write(`${text}\n`);
  const summary = env("GITHUB_STEP_SUMMARY");
  if (summary) appendFileSync(summary, `\`\`\`\n${text}\n\`\`\`\n`);
  if (results.some((result) => result.status === "leak")) return 1;
  if (results.some((result) => result.status === "blind")) return 2;
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`credential leak monitor: ${safeError(error)}\n`);
    process.exit(2);
  },
);
