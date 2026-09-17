import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const MAX_PAGES = 100;
const COMMENT_LIMIT = 64_000;
const REPORT_REQUEST_TIMEOUT_MS = 30_000;
// GitHub discards a step summary over 1 MiB, taking the verdict with it.
export const SUMMARY_LIMIT = 900_000;

const validId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);

// A receipt is written by the eval command, so its destination decides where
// the MCPJam API key is sent. Accept only the origin this action was
// configured for, and otherwise only a credential-free HTTPS origin.
function receiptOrigin(value, allowedOrigin) {
  if (typeof value !== "string") return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  if (url.protocol !== "https:") return undefined;
  if (allowedOrigin) return url.origin === allowedOrigin ? url.origin : undefined;
  return url.origin;
}

export async function readActionReceipts(directory, allowedOrigin) {
  const receipts = [];
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".json")) continue;
    let value;
    try {
      value = JSON.parse(await readFile(`${directory}/${file}`, "utf8"));
    } catch {
      continue;
    }
    const baseUrl = receiptOrigin(value?.baseUrl, allowedOrigin);
    if (
      baseUrl &&
      value?.schemaVersion === 1 &&
      validId(value.projectId) &&
      validId(value.suiteId) &&
      validId(value.runId) &&
      typeof value.suiteName === "string"
    ) {
      receipts.push({ ...value, baseUrl });
    }
  }
  return [
    ...new Map(receipts.map((receipt) => [receipt.runId, receipt])).values(),
  ];
}

/**
 * Service-token headers for a deployment behind an identity proxy.
 *
 * A staging or self-hosted MCPJam can sit behind Cloudflare Access, which
 * answers the API with its own login page long before the bearer token is
 * read. These ride ONLY on the MCPJam requests below, never on the GitHub
 * ones, and a value carrying a newline is dropped rather than split into
 * extra headers.
 */
export function accessHeadersFromEnv(env = process.env) {
  const clean = (value) => {
    const trimmed = (value ?? "").trim();
    return trimmed && !/[\r\n]/.test(trimmed) ? trimmed : "";
  };
  const id = clean(env.CF_ACCESS_CLIENT_ID);
  const secret = clean(env.CF_ACCESS_CLIENT_SECRET);
  if (!id || !secret) return {};
  return { "cf-access-client-id": id, "cf-access-client-secret": secret };
}

async function apiJson(baseUrl, path, apiKey, fetchImpl, accessHeaders = {}) {
  const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
  const response = await fetchImpl(url, {
    headers: { ...accessHeaders, authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REPORT_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`MCPJam API returned ${response.status}.`);
  return response.json();
}

export async function fetchRunBundle(
  receipt,
  apiKey,
  fetchImpl = fetch,
  accessHeaders = {},
) {
  const root = `/api/v1/projects/${encodeURIComponent(receipt.projectId)}`;
  const runPath = `${root}/eval-runs/${encodeURIComponent(receipt.runId)}`;
  let run = await apiJson(
    receipt.baseUrl,
    runPath,
    apiKey,
    fetchImpl,
    accessHeaders,
  );
  if (!TERMINAL.has(run.status)) {
    throw new Error(`Eval run ${receipt.runId} is still ${run.status}.`);
  }
  const iterations = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const result = await apiJson(
      receipt.baseUrl,
      `${runPath}/iterations?${query}`,
      apiKey,
      fetchImpl,
      accessHeaders,
    );
    if (!Array.isArray(result.items)) throw new Error("Invalid iteration page.");
    iterations.push(...result.items);
    if (!result.nextCursor) return { receipt, run, iterations };
    cursor = result.nextCursor;
  }
  throw new Error(`Eval run ${receipt.runId} exceeded the iteration page limit.`);
}

const escapeCell = (value) =>
  String(value ?? "—")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
const pct = (passed, total) =>
  total > 0 ? `${Math.round((passed / total) * 100)}% (${passed}/${total})` : "—";
const duration = (ms) => {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
};
const money = (value) =>
  Number.isFinite(value) ? `$${value.toFixed(value < 0.01 ? 4 : 2)}` : "—";
const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};
const variantKey = (provider, model) => `${provider ?? ""}\0${model ?? ""}`;
// The column is "Client / Model" and holds nothing else. The provider and the
// test framework are neither, and a reader comparing rows takes whatever sits
// in that cell for a client.
const variantLabel = (client, model) =>
  [client, model].filter(Boolean).join(" / ") || "Default";
const RESULT_LABELS = {
  passed: "Passed",
  failed: "Failed",
  inconclusive: "Inconclusive",
  cancelled: "Cancelled",
  timed_out: "Timed out",
};
const resultLabel = (value) => RESULT_LABELS[value] ?? "Unknown";
const statusIcon = (verdict) =>
  verdict === "passed" ? "✅" : verdict === "failed" ? "❌" : "⚠️";

function groupIterations(bundle) {
  const groups = new Map();
  for (const iteration of bundle.iterations) {
    const provider = iteration.provider ?? null;
    const model = iteration.model ?? bundle.run.effectiveModelId ?? null;
    const caseKey = iteration.testCaseId ?? iteration.caseId ?? iteration.title;
    const key = [caseKey, variantKey(provider, model)].join("\0");
    if (!groups.has(key)) {
      groups.set(key, {
        caseKey,
        title: iteration.title || "Unknown case",
        declaredCaseId: iteration.caseId,
        testCaseId: iteration.testCaseId,
        provider,
        model,
        iterations: [],
      });
    }
    groups.get(key).iterations.push(iteration);
  }
  return [...groups.values()];
}

// The ids the backend could have minted for this group, in its own order.
// A stored `caseKey` is encoded into the `k_`/`kh_` spaces, and the public
// iteration DTO does not carry it, so a hosted case is frequently unjoinable.
const mintedCandidates = (group) =>
  [
    group.testCaseId ? `c_${group.testCaseId}` : undefined,
    group.declaredCaseId ? `d_${group.declaredCaseId}` : undefined,
  ].filter(Boolean);

const entryVariantKey = (entry) =>
  entry.executionVariant
    ? variantKey(
        entry.executionVariant.provider ?? null,
        entry.executionVariant.model,
      )
    : null;

function tallyGroup(group) {
  const passed = group.iterations.filter((row) => row.result === "passed").length;
  const failed = group.iterations.filter((row) => row.result === "failed").length;
  return { passed, failed, eligible: passed + failed };
}

const groupErrors = (group) =>
  (group?.iterations ?? []).map((row) => row.error).filter(Boolean);

/**
 * One row per decided case-variant.
 *
 * A run that carries a decision is the ONLY authority for its own verdicts,
 * counts and thresholds: re-deriving them from raw trials produces a table
 * that contradicts the run's own result whenever a case passes below 100%.
 * So the rows come from the decision, and the iterations only supply the
 * title, the timings and the recorded errors. A run with no decision (a
 * legacy run) has nothing but its trials, and is tallied from them.
 */
function buildCaseRows(bundle) {
  const groups = groupIterations(bundle);
  const decisions = Array.isArray(bundle.run.verdictSummary?.cases)
    ? bundle.run.verdictSummary.cases
    : [];
  if (decisions.length === 0) {
    return groups.map((group) => {
      const { passed, failed, eligible } = tallyGroup(group);
      return {
        ...group,
        passed,
        failed,
        eligible,
        verdict: eligible === 0 ? "inconclusive" : failed ? "failed" : "passed",
        threshold: undefined,
        errors: groupErrors(group),
      };
    });
  }

  const unmatched = new Set(groups);
  const rows = decisions.map((entry) => {
    const group = groups.find(
      (candidate) =>
        unmatched.has(candidate) &&
        mintedCandidates(candidate).includes(entry.caseId) &&
        (!entry.executionVariant ||
          entryVariantKey(entry) ===
            variantKey(candidate.provider, candidate.model)),
    );
    if (group) unmatched.delete(group);
    return { entry, group };
  });
  // A decision row and an iteration group left alone in one execution variant
  // can only be each other, so a case whose minted id this action cannot
  // reproduce still recovers its title without guessing at its verdict.
  for (const bucket of new Set(rows.map((row) => entryVariantKey(row.entry)))) {
    const pending = rows.filter(
      (row) => !row.group && entryVariantKey(row.entry) === bucket,
    );
    const peers = [...unmatched].filter(
      (group) => bucket === null || variantKey(group.provider, group.model) === bucket,
    );
    if (pending.length === 1 && peers.length === 1) {
      pending[0].group = peers[0];
      unmatched.delete(peers[0]);
    }
  }

  return rows.map(({ entry, group }) => ({
    caseKey: group?.caseKey ?? entry.caseId,
    title: group?.title ?? `Case ${entry.caseId}`,
    provider: group?.provider ?? entry.executionVariant?.provider ?? null,
    model: group?.model ?? entry.executionVariant?.model ?? null,
    iterations: group?.iterations ?? [],
    passed: entry.passedTrials,
    failed: entry.failedTrials,
    eligible: entry.eligibleTrials,
    verdict: entry.verdict,
    threshold: entry.effectivePassThreshold,
    errors: groupErrors(group),
  }));
}

export function truncateMarkdown(text, limit, note) {
  const bytes = (value) => Buffer.byteLength(value, "utf8");
  if (bytes(text) <= limit) return text;
  if (bytes(note) > limit) return "";
  let content = "";
  for (const line of text.split("\n")) {
    const next = `${content ? `${content}\n` : ""}${line}`;
    if (bytes(next) + bytes(note) > limit) break;
    content = next;
  }
  return content + note;
}

function table(headers, rows) {
  return [
    `| ${headers.map(escapeCell).join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n");
}

function renderBundle(bundle, full, outcome) {
  const cases = buildCaseRows(bundle);
  const variants = [
    ...new Map(
      cases.map((row) => [
        variantKey(row.provider, row.model),
        { key: variantKey(row.provider, row.model), provider: row.provider, model: row.model },
      ]),
    ).values(),
  ];
  // The run names the client it executed: a saved MCPJam client, or the
  // synthetic "SDK harness" when the test code owned the model. `environment`
  // is a project environment, not a client, and is the weaker label of the two.
  // Truthiness, not nullish: an empty name is no name, and must not shadow the
  // environment the run does carry.
  const client = bundle.run.client?.name || bundle.run.environment?.name;
  const variantRows = variants.map((variant) => {
    const rows = cases.filter((row) => variantKey(row.provider, row.model) === variant.key);
    const passedCases = rows.filter((row) => row.verdict === "passed").length;
    const eligible = rows.reduce((sum, row) => sum + row.eligible, 0);
    const passed = rows.reduce((sum, row) => sum + row.passed, 0);
    const times = rows.flatMap((row) => row.iterations.map((item) => item.durationMs));
    const verdict = rows.some((row) => row.verdict === "failed")
      ? "failed"
      : rows.some((row) => row.verdict === "inconclusive")
        ? "inconclusive"
        : "passed";
    return [
      variantLabel(client, variant.model),
      `${statusIcon(verdict)} ${verdict[0].toUpperCase()}${verdict.slice(1)}`,
      `${passedCases}/${rows.length}`,
      pct(passed, eligible),
      `${duration(percentile(times, 0.5))} / ${duration(percentile(times, 0.95))}`,
    ];
  });
  const failedCases = cases.filter((row) => row.verdict !== "passed");
  // Keyed by case identity, never by title: two cases may share a title, and
  // matching on it shows one case's pass rate under the other's failure.
  const failedKeys = [...new Set(failedCases.map((row) => row.caseKey))];
  const failedRows = failedKeys.map((caseKey) => [
    cases.find((row) => row.caseKey === caseKey)?.title ?? caseKey,
    ...variants.map((variant) => {
      const row = cases.find(
        (item) =>
          item.caseKey === caseKey &&
          variantKey(item.provider, item.model) === variant.key,
      );
      return row
        ? `${statusIcon(row.verdict)} ${pct(row.passed, row.eligible)}`
        : "—";
    }),
  ]);
  const caseCount = new Set(cases.map((row) => row.caseKey)).size;
  const total = cases.reduce((sum, row) => sum + row.eligible, 0);
  const passed = cases.reduce((sum, row) => sum + row.passed, 0);
  const runNumber = bundle.run.runNumber ? `Run #${bundle.run.runNumber}` : `Run ${bundle.run.id}`;
  const threshold = cases.find((row) => Number.isFinite(row.threshold))?.threshold;
  // Open the exact run in the public Evaluate experience.
  const link = new URL(
    `/evaluate/suite/${encodeURIComponent(bundle.receipt.suiteId)}/runs/${encodeURIComponent(bundle.receipt.runId)}`,
    bundle.receipt.baseUrl,
  );
  link.searchParams.set("project", bundle.receipt.projectId);
  // The headline is the ACTION's verdict when it has one. The run's own result
  // is one input to it — a waived gate passes a failed run, a command that
  // exits non-zero fails a passed one — so reporting the run result as the
  // outcome contradicts the check the reader is looking at.
  const headline = outcome?.result ?? bundle.run.result;
  const lines = [
    `## ${statusIcon(headline)} MCPJam Evals — ${resultLabel(headline)}`,
    "",
    ...(outcome?.message ? [`${escapeCell(outcome.message)}  `] : []),
    `**${escapeCell(bundle.receipt.suiteName)} · ${runNumber}**  `,
    `Run result: ${statusIcon(bundle.run.result)} ${resultLabel(bundle.run.result)}  `,
    `${caseCount} cases · ${passed}/${total} eligible iterations passed · ${variants.length} client/model combination${variants.length === 1 ? "" : "s"}  `,
    ...(Number.isFinite(threshold)
      ? [`**Requirement:** Each case must pass ≥${Math.round(threshold * 100)}% of its eligible iterations.`, ""]
      : [""]),
    table(
      ["Client / Model", "Result", "Cases passed", "Iteration pass rate", "P50 / P95"],
      variantRows,
    ),
    "",
    "### Failed cases",
    "",
    ...(failedRows.length
      ? [
          "Each cell shows the recorded pass rate over eligible iterations.",
          "",
          table(
            ["Case", ...variants.map((row) => variantLabel(client, row.model))],
            failedRows,
          ),
        ]
      : ["No failed or inconclusive cases."]),
    "",
  ];

  const comment = [...lines, `[View full run in MCPJam](${link})`].join("\n");
  if (!full) return comment;

  const passing = cases.filter((row) => row.verdict === "passed");
  const errors = failedCases.flatMap((row) =>
    row.errors.length ? row.errors.map((error) => [row.title, error]) : [],
  );
  const usageRows = variants.map((variant) => {
    const items = cases
      .filter((row) => variantKey(row.provider, row.model) === variant.key)
      .flatMap((row) => row.iterations);
    const times = items.map((item) => item.durationMs);
    const tokens = items.reduce((sum, item) => sum + (item.usage?.totalTokens ?? item.tokensUsed ?? 0), 0);
    const costs = items.map((item) => item.usage?.estimatedCostUsd).filter(Number.isFinite);
    const tools = items.reduce((sum, item) => sum + (item.actualToolCalls?.length ?? 0), 0);
    return [
      variantLabel(client, variant.model),
      duration(percentile(times, 0.5)),
      duration(percentile(times, 0.95)),
      tokens || "—",
      costs.length ? money(costs.reduce((sum, value) => sum + value, 0)) : "—",
      tools,
    ];
  });
  const completed = bundle.iterations.filter((row) =>
    ["completed", "failed", "setup_failed", "timed_out", "skipped", "cancelled"].includes(row.status),
  ).length;
  const executionErrors = bundle.iterations.filter((row) =>
    ["failed", "setup_failed", "timed_out"].includes(row.status),
  ).length;
  const skipped = bundle.iterations.filter((row) => row.status === "skipped").length;
  const cancelled = bundle.iterations.filter((row) => row.status === "cancelled").length;
  const commit = bundle.run.ciMetadata?.commitSha;
  return [
    ...lines,
    ...(errors.length
      ? ["### Recorded failures", "", table(["Case", "Recorded reason"], errors), ""]
      : []),
    ...(passing.length
      ? [
          `<details><summary>${passing.length} passing case${passing.length === 1 ? "" : "s"}</summary>`,
          "",
          table(
            ["Case", "Client / Model", "Pass rate"],
            passing.map((row) => [
              row.title,
              variantLabel(client, row.model),
              pct(row.passed, row.eligible),
            ]),
          ),
          "",
          "</details>",
          "",
        ]
      : []),
    "<details><summary>Usage and performance</summary>",
    "",
    table(
      ["Client / Model", "P50 latency", "P95 latency", "Total tokens", "Estimated cost", "Tool calls"],
      usageRows,
    ),
    "",
    "</details>",
    "",
    "<details><summary>Run details</summary>",
    "",
    table(
      ["Setting", "Value"],
      [
        ["Suite", bundle.receipt.suiteName],
        ["Commit", commit ? `\`${commit.slice(0, 7)}\`` : "—"],
        ["Completed iterations", `${completed}/${bundle.iterations.length}`],
        ["Execution errors", executionErrors],
        ["Skipped / cancelled", `${skipped} / ${cancelled}`],
      ],
    ),
    "",
    "</details>",
    "",
    `[View full run in MCPJam](${link})`,
  ].join("\n");
}

export function renderReports(bundles, outcome) {
  return {
    summary: bundles
      .map((bundle) => renderBundle(bundle, true, outcome))
      .join("\n\n---\n\n"),
    comment: bundles
      .map((bundle) => renderBundle(bundle, false, outcome))
      .join("\n\n---\n\n"),
  };
}

export function commentMarker(env) {
  const identity = [env.GITHUB_REPOSITORY, env.GITHUB_WORKFLOW, env.GITHUB_JOB, env.MCPJAM_ACTION_INVOCATION, env.MCPJAM_ACTION_MATRIX];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 20);
}

export async function publishPullRequestComment(body, env, fetchImpl = fetch) {
  const repository = env.GITHUB_REPOSITORY;
  const pull = Number(env.MCPJAM_ACTION_PULL_REQUEST);
  const token = env.MCPJAM_ACTION_GITHUB_TOKEN;
  if (!repository || !Number.isSafeInteger(pull) || pull < 1 || !token) {
    throw new Error("PR comment needs a pull request and a GitHub token.");
  }
  const markerId = commentMarker(env);
  const run = Number(env.GITHUB_RUN_ID) || 0;
  const attempt = Number(env.GITHUB_RUN_ATTEMPT) || 1;
  const marker = `<!-- mcpjam-evals:${markerId} run=${run} attempt=${attempt} -->`;
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
  let existing;
  for (let page = 1; page <= 10 && !existing; page += 1) {
    const response = await fetchImpl(`${api}/repos/${repository}/issues/${pull}/comments?per_page=100&page=${page}`, {
      headers,
      signal: AbortSignal.timeout(REPORT_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status} while reading comments.`);
    const comments = await response.json();
    existing = comments.find((comment) => comment.body?.includes(`<!-- mcpjam-evals:${markerId} `));
    if (comments.length < 100) break;
  }
  const old = existing?.body?.match(/ run=(\d+) attempt=(\d+) /);
  if (old && (Number(old[1]) > run || (Number(old[1]) === run && Number(old[2]) > attempt))) return "stale";
  const content = truncateMarkdown(
    `${marker}\n${body}`,
    COMMENT_LIMIT,
    "\n\n_Comment truncated. View the complete checks summary and MCPJam run._",
  );
  const url = existing
    ? `${api}/repos/${repository}/issues/comments/${existing.id}`
    : `${api}/repos/${repository}/issues/${pull}/comments`;
  const response = await fetchImpl(url, {
    method: existing ? "PATCH" : "POST",
    signal: AbortSignal.timeout(REPORT_REQUEST_TIMEOUT_MS),
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ body: content }),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} while writing the comment.`);
  return existing ? "updated" : "created";
}
