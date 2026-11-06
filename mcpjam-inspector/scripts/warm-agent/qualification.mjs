// Summarize matched development measurements. Missing or invented observations
// must never qualify a rollout. Input is a JSON array of trios from the runner.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { assertFollowupWindow } from "./evidence.mjs";

const deadline = 60_000;
const paths = ["off", "on", "cli"];
const orders = [
  ["off", "on", "cli"],
  ["on", "cli", "off"],
  ["cli", "off", "on"],
  ["cli", "on", "off"],
  ["off", "cli", "on"],
  ["on", "off", "cli"],
];

export function schedule(client, workload) {
  return Array.from({ length: 40 }, (_, index) => ({
    client,
    workload,
    index,
    paths: orders[index % orders.length],
    // Interleave the windows to avoid assigning all long waits to a later load period.
    window: index % 4 === 3 ? "long" : "short",
    waitMs:
      index % 4 === 3
        ? (300 + 30 * (index >> 2)) * 1000
        : (30 + ((index * 13) % 31)) * 1000,
  }));
}

const sorted = (numbers) => [...numbers].sort((a, b) => a - b);
const median = (values) => {
  const s = sorted(values),
    mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const percentile = (values, p) =>
  sorted(values)[Math.ceil(values.length * p) - 1];

function interval(gaps) {
  // Seeded paired bootstrap. Resample whole trios within each window so the
  // rollout's 30:10 mix survives in every bootstrap sample.
  let seed = 42;
  const draw = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 2 ** 32) * n);
  };
  const buckets = ["short", "long"].map((window) =>
    gaps.filter((g) => g.window === window),
  );
  const estimates = Array.from({ length: 4000 }, () =>
    percentile(
      buckets.flatMap((bucket) =>
        bucket.map(() => bucket[draw(bucket.length)].ms),
      ),
      0.95,
    ),
  );
  return [percentile(estimates, 0.025), percentile(estimates, 0.975)];
}

function score(entry, path, workload, window) {
  const sample = entry[path];
  if (!sample || typeof sample.failed !== "boolean")
    throw Error("Missing measured path");
  const wait = sample.followupMs;
  let validWindow = true;
  try {
    assertFollowupWindow(wait, window);
  } catch (error) {
    if (!sample.failed) throw error;
    validWindow = false;
  }
  const expected =
    path === "cli"
      ? workload === "text"
        ? "stdout-text"
        : "stdout-tool-start"
      : workload === "text"
        ? "painted-text"
        : "painted-tool-start";
  if (
    !sample.failed &&
    (sample.event !== expected || !Number.isFinite(sample.ms) || sample.ms < 0)
  ) {
    throw Error("Invalid qualifying output");
  }
  const box = entry.sandboxIds?.[path === "cli" ? "on" : path];
  const identicalBox =
    typeof box === "string" &&
    box.length > 0 &&
    entry.sandboxIds.off !== entry.sandboxIds.on &&
    sample.sandboxId === box;
  const independentChats =
    typeof entry.chatIds?.off === "string" &&
    typeof entry.chatIds?.on === "string" &&
    entry.chatIds.off !== entry.chatIds.on;
  if (!independentChats)
    throw Error("Each Playground arm requires an independent chat.");

  const parts = sample.nativeProcess;
  const hasIdentity = (id) =>
    Number.isSafeInteger(id?.pid) &&
    id.pid > 0 &&
    typeof id?.birth === "string" &&
    id.birth.length > 0;
  const observed = hasIdentity(parts?.before) && hasIdentity(parts?.after);
  const reused =
    observed &&
    parts.before.pid === parts.after.pid &&
    parts.before.birth === parts.after.birth;
  const expectedProcess = observed && (path === "off" ? !reused : reused);
  const protocolFailure =
    !validWindow ||
    !Number.isFinite(sample.submittedAt) ||
    sample.protocolFailure === true ||
    sample.reason === "Follow-up outside assigned window" ||
    !identicalBox ||
    (path === "off" && reused);
  const missed =
    protocolFailure ||
    sample.failed ||
    sample.ms >= deadline ||
    !identicalBox ||
    !independentChats ||
    !expectedProcess;
  return {
    ms: missed ? deadline : sample.ms,
    missed,
    timedOut: !protocolFailure && sample.ms >= deadline,
    protocolFailure,
    reused,
  };
}

export function workloadResult(trios, client, workload) {
  const group = trios.filter(
    (t) => t.client === client && t.workload === workload,
  );
  if (!group.length) return { count: 0, qualified: false };
  const seen = new Set(),
    data = [];
  const plan = schedule(client, workload);
  for (const entry of group) {
    const planned = plan[entry.index];
    if (
      !planned ||
      seen.has(entry.index) ||
      entry.window !== planned.window ||
      JSON.stringify(planned.paths) !== JSON.stringify(entry.order)
    )
      throw Error("Invalid or repeated trio");
    seen.add(entry.index);
    const row = Object.fromEntries(
      paths.map((p) => [p, score(entry, p, workload, entry.window)]),
    );
    const matched =
      typeof entry.matchId === "string" &&
      entry.matchId.length > 0 &&
      paths.every((p) => entry[p].matchId === entry.matchId);
    if (!matched) throw Error("Trio settings or history differ");
    data.push({ ...row, window: entry.window, reused: row.on.reused });
  }
  const summarize = (rows) => {
    if (!rows.length) return { count: 0 };
    const misses = Object.fromEntries(
      paths.map((p) => [p, rows.filter((r) => r[p].missed).length]),
    );
    const timeouts = Object.fromEntries(
      paths.map((p) => [p, rows.filter((r) => r[p].timedOut).length]),
    );
    const protocolFailures = Object.fromEntries(
      paths.map((p) => [p, rows.filter((r) => r[p].protocolFailure).length]),
    );
    const p95 = Object.fromEntries(
      paths.map((p) => [
        p,
        percentile(
          rows.map((r) => r[p].ms),
          0.95,
        ),
      ]),
    );
    return {
      count: rows.length,
      pairedMedianMs: median(rows.map((r) => r.off.ms - r.on.ms)),
      p95,
      timeouts,
      protocolFailures,
      misses,
      confirmedReuse: rows.filter((r) => r.reused).length,
      cliTargetPasses: rows.filter(
        (r) => !r.on.missed && !r.cli.missed && r.on.ms - r.cli.ms < 1000,
      ).length,
    };
  };
  const all = summarize(data),
    complete = all.count === 40;
  const measurementValid =
    complete && paths.every((p) => all.protocolFailures[p] === 0);
  const gaps = data.map((r) => ({ window: r.window, ms: r.on.ms - r.cli.ms }));
  return {
    ...all,
    complete,
    measurementValid,
    // A disk restart cannot supply evidence for a retained-process speedup.
    staffSpeedGate:
      measurementValid &&
      all.pairedMedianMs >= 750 &&
      all.p95.on <= all.p95.off &&
      all.timeouts.on <= all.timeouts.off &&
      all.misses.on <= all.misses.off,
    cliGapP95Ms: percentile(
      gaps.map((g) => g.ms),
      0.95,
    ),
    ...(complete ? { cliGapP95IntervalMs: interval(gaps) } : {}),
    windows: Object.fromEntries(
      ["short", "long"].map((w) => [
        w,
        summarize(data.filter((r) => r.window === w)),
      ]),
    ),
  };
}

export function verdict(trios, client, safetyPassed = false, repeatTrios = []) {
  const workloads = Object.fromEntries(
    ["text", "tool"].map((w) => [w, workloadResult(trios, client, w)]),
  );
  const staff =
    safetyPassed && Object.values(workloads).every((w) => w.staffSpeedGate);
  const broad =
    staff &&
    Object.entries(workloads).every(([workload, w]) => {
      if (w.cliTargetPasses > 38) return true;
      if (w.cliTargetPasses !== 38) return false;
      const originalRuns = new Set(
        trios
          .filter((t) => t.client === client && t.workload === workload)
          .map((t) => t.batchId),
      );
      const candidates = repeatTrios.filter(
        (t) =>
          typeof t.batchId === "string" &&
          t.batchId.length > 0 &&
          !originalRuns.has(t.batchId),
      );
      const repeat = workloadResult(candidates, client, workload);
      return repeat.measurementValid && repeat.cliTargetPasses >= 38;
    });
  return { client, staff, broad, workloads };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const evidence = JSON.parse(await readFile(process.argv[2], "utf8"));
  console.log(
    JSON.stringify(
      ["claude-code", "codex"].map((c) =>
        verdict(
          evidence.trios,
          c,
          evidence.safety?.[c] === true,
          evidence.repeatTrios ?? [],
        ),
      ),
      null,
      2,
    ),
  );
}
