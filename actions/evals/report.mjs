import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const MAX_PAGES = 100;
const COMMENT_LIMIT = 64_000;

const validId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);

export async function readActionReceipts(directory) {
  const receipts = [];
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".json")) continue;
    let value;
    try {
      value = JSON.parse(await readFile(`${directory}/${file}`, "utf8"));
    } catch {
      continue;
    }
    if (
      value?.schemaVersion === 1 &&
      typeof value.baseUrl === "string" &&
      validId(value.projectId) &&
      validId(value.suiteId) &&
      validId(value.runId) &&
      typeof value.suiteName === "string"
    ) {
      receipts.push(value);
    }
  }
  return [
    ...new Map(receipts.map((receipt) => [receipt.runId, receipt])).values(),
  ];
}

async function apiJson(baseUrl, path, apiKey, fetchImpl) {
  const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`MCPJam API returned ${response.status}.`);
  return response.json();
}

export async function fetchRunBundle(receipt, apiKey, fetchImpl = fetch) {
  const root = `/api/v1/projects/${encodeURIComponent(receipt.projectId)}`;
  const runPath = `${root}/eval-runs/${encodeURIComponent(receipt.runId)}`;
  let run = await apiJson(receipt.baseUrl, runPath, apiKey, fetchImpl);
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
const variantLabel = (client, model, provider) =>
  [client || provider, model].filter(Boolean).join(" / ") || "Default";
const statusIcon = (verdict) =>
  verdict === "passed" ? "✅" : verdict === "failed" ? "❌" : "⚠️";

function buildCaseRows(bundle) {
  const groups = new Map();
  for (const iteration of bundle.iterations) {
    const provider = iteration.provider ?? null;
    const model = iteration.model ?? bundle.run.effectiveModelId ?? null;
    const key = [iteration.testCaseId ?? iteration.caseId ?? iteration.title, variantKey(provider, model)].join("\0");
    if (!groups.has(key)) {
      groups.set(key, {
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

  const decisions = Array.isArray(bundle.run.verdictSummary?.cases)
    ? bundle.run.verdictSummary.cases
    : [];
  return [...groups.values()].map((group) => {
    const decision = decisions.find((entry) => {
      // The backend namespaces stored row ids with `c_` and SDK-declared ids
      // with `d_`. Prefer the stored identity, as the run UI does. Never join
      // a raw iteration id directly to the encoded decision identity.
      const candidates = [
        group.testCaseId ? `c_${group.testCaseId}` : undefined,
        group.declaredCaseId ? `d_${group.declaredCaseId}` : undefined,
      ].filter(Boolean);
      if (!candidates.includes(entry.caseId)) return false;
      if (!entry.executionVariant) return true;
      return (
        entry.executionVariant.model === group.model &&
        (entry.executionVariant.provider ?? null) === group.provider
      );
    });
    const passed = decision?.passedTrials ?? group.iterations.filter((row) => row.result === "passed").length;
    const failed = decision?.failedTrials ?? group.iterations.filter((row) => row.result === "failed").length;
    const eligible = decision?.eligibleTrials ?? passed + failed;
    const verdict = decision?.verdict ?? (eligible === 0 ? "inconclusive" : failed ? "failed" : "passed");
    return {
      ...group,
      passed,
      failed,
      eligible,
      verdict,
      threshold: decision?.effectivePassThreshold,
      errors: group.iterations.map((row) => row.error).filter(Boolean),
    };
  });
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n");
}

function renderBundle(bundle, full) {
  const cases = buildCaseRows(bundle);
  const variants = [
    ...new Map(
      cases.map((row) => [
        variantKey(row.provider, row.model),
        { key: variantKey(row.provider, row.model), provider: row.provider, model: row.model },
      ]),
    ).values(),
  ];
  const client = bundle.run.environment?.name ?? bundle.receipt.framework;
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
      variantLabel(client, variant.model, variant.provider),
      `${statusIcon(verdict)} ${verdict[0].toUpperCase()}${verdict.slice(1)}`,
      `${passedCases}/${rows.length}`,
      pct(passed, eligible),
      `${duration(percentile(times, 0.5))} / ${duration(percentile(times, 0.95))}`,
    ];
  });
  const failedCases = cases.filter((row) => row.verdict !== "passed");
  const caseTitles = [...new Set(failedCases.map((row) => row.title))];
  const failedRows = caseTitles.map((title) => [
    title,
    ...variants.map((variant) => {
      const row = cases.find(
        (item) => item.title === title && variantKey(item.provider, item.model) === variant.key,
      );
      return row
        ? `${statusIcon(row.verdict)} ${pct(row.passed, row.eligible)}`
        : "—";
    }),
  ]);
  const caseCount = new Set(cases.map((row) => row.title)).size;
  const total = cases.reduce((sum, row) => sum + row.eligible, 0);
  const passed = cases.reduce((sum, row) => sum + row.passed, 0);
  const runNumber = bundle.run.runNumber ? `Run #${bundle.run.runNumber}` : `Run ${bundle.run.id}`;
  const threshold = cases.find((row) => Number.isFinite(row.threshold))?.threshold;
  const link = new URL(
    `/evals/suite/${encodeURIComponent(bundle.receipt.suiteId)}/runs/${encodeURIComponent(bundle.receipt.runId)}`,
    bundle.receipt.baseUrl,
  );
  link.searchParams.set("project", bundle.receipt.projectId);
  const lines = [
    `## ${statusIcon(bundle.run.result)} MCPJam Evals — ${bundle.run.result === "passed" ? "Passed" : bundle.run.result === "inconclusive" ? "Inconclusive" : "Failed"}`,
    "",
    `**${escapeCell(bundle.receipt.suiteName)} · ${runNumber}**  `,
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
            ["Case", ...variants.map((row) => variantLabel(client, row.model, row.provider))],
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
      variantLabel(client, variant.model, variant.provider),
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
              variantLabel(client, row.model, row.provider),
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

export function renderReports(bundles) {
  return {
    summary: bundles.map((bundle) => renderBundle(bundle, true)).join("\n\n---\n\n"),
    comment: bundles.map((bundle) => renderBundle(bundle, false)).join("\n\n---\n\n"),
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
    const response = await fetchImpl(`${api}/repos/${repository}/issues/${pull}/comments?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`GitHub returned ${response.status} while reading comments.`);
    const comments = await response.json();
    existing = comments.find((comment) => comment.body?.includes(`<!-- mcpjam-evals:${markerId} `));
    if (comments.length < 100) break;
  }
  const old = existing?.body?.match(/ run=(\d+) attempt=(\d+) /);
  if (old && (Number(old[1]) > run || (Number(old[1]) === run && Number(old[2]) > attempt))) return "stale";
  let content = `${marker}\n${body}`;
  if (content.length > COMMENT_LIMIT) {
    const note = "\n\n_Comment truncated. View the complete checks summary and MCPJam run._";
    const lines = content.split("\n");
    content = "";
    for (const line of lines) {
      if (content.length + line.length + 1 + note.length > COMMENT_LIMIT) break;
      content += `${content ? "\n" : ""}${line}`;
    }
    content += note;
  }
  const url = existing
    ? `${api}/repos/${repository}/issues/comments/${existing.id}`
    : `${api}/repos/${repository}/issues/${pull}/comments`;
  const response = await fetchImpl(url, {
    method: existing ? "PATCH" : "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ body: content }),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} while writing the comment.`);
  return existing ? "updated" : "created";
}
