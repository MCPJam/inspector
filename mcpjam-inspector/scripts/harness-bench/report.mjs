#!/usr/bin/env node
/**
 * Summarise bench.mjs results.
 *
 *   node scripts/harness-bench/report.mjs <results.jsonl> [--run <id>] [--metric sendToPainted]
 *   node scripts/harness-bench/report.mjs <results.jsonl> --timeline <row number>
 *   node scripts/harness-bench/report.mjs <results.jsonl> --stages
 *
 * `--stages` adds, under each label, the median of each stage: the browser's
 * Enter-to-request and finish-to-close, the route's stages, and the turn's
 * own (claim, broker, session connect, dispatch to first text).
 * The summary gives, per label × client × workload, the measured turns, the
 * failures, the median and range of the metric, and for two labels the
 * median of the paired differences (second label minus first, by pair).
 */
import { readFileSync } from "node:fs";

const [file, ...rest] = process.argv.slice(2);
const option = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const run = option("--run");
const metric = option("--metric") ?? "sendToPainted";
const selected = rows.filter((r) => !run || r.run === run);

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}
const s = (ms) => (ms == null ? "-" : (ms / 1000).toFixed(2));

const timelineRow = option("--timeline");
if (timelineRow !== undefined) {
  const row = selected[Number(timelineRow)];
  const trace = row.server?.trace ?? [];
  const origin = trace.find((e) => e.name === "route.start")?.t ?? trace[0]?.t;
  console.log(`${row.instance} ${row.label} ${row.workload} ok=${row.ok} ${row.failure ?? ""}`);
  console.log("browser:", JSON.stringify(row.browser, ["sendToRequest", "requestToHeaders", "headersToFirstChunk", "sendToFirstTextDelta", "firstTextDeltaToDom", "sendToPainted", "finishToClose", "sendToClose"]));
  console.log("timing:", JSON.stringify(row.server?.timing));
  for (const e of trace) {
    const at = e.t - origin;
    const end = e.durMs != null ? `→${at + e.durMs}` : "";
    console.log(`${String(at).padStart(6)}${end.padEnd(8)} ${e.name.padEnd(22)} ${e.durMs != null ? String(e.durMs).padStart(5) + "ms" : "       "} ${e.detail ?? ""}`.slice(0, 200));
  }
  process.exit(0);
}

const groups = new Map();
for (const row of selected) {
  if (row.primer) continue;
  const key = `${row.client} | ${row.workload}`;
  if (!groups.has(key)) groups.set(key, new Map());
  const byLabel = groups.get(key);
  if (!byLabel.has(row.label)) byLabel.set(row.label, []);
  byLabel.get(row.label).push(row);
}

const primers = selected.filter((r) => r.primer);
console.log(`run(s): ${[...new Set(selected.map((r) => r.run))].join(", ")}  metric: ${metric}  primers: ${primers.length} (${primers.filter((r) => !r.ok).length} failed)`);
for (const [key, byLabel] of groups) {
  console.log(`\n${key}`);
  const labels = [...byLabel.keys()];
  const stageLines = [];
  for (const label of labels) {
    const list = byLabel.get(label);
    const ok = list.filter((r) => r.ok && r.browser?.[metric] != null);
    const values = ok.map((r) => r.browser[metric]);
    const starts = {};
    for (const r of list) {
      const ev = r.server?.turnEvents?.at(-1);
      const k = `${ev?.start ?? "?"}/${ev?.fallback_reason ?? "?"}`;
      starts[k] = (starts[k] ?? 0) + 1;
    }
    const failures = list.filter((r) => !r.ok).map((r) => r.failure);
    if (rest.includes("--stages")) stageLines.push([label, ok]);
    console.log(
      `  ${label.padEnd(16)} n=${String(list.length).padStart(2)} ok=${String(ok.length).padStart(2)} median=${s(median(values))}s range=${s(Math.min(...values))}–${s(Math.max(...values))}s  starts=${JSON.stringify(starts)}${failures.length ? `  failures=${JSON.stringify(failures)}` : ""}`,
    );
  }
  for (const [label, ok] of stageLines) {
    const pick = (read) => median(ok.map(read).filter((v) => typeof v === "number" && Number.isFinite(v)));
    const t = (r) => r.server?.timing ?? {};
    const stages = {
      enter: pick((r) => r.browser?.sendToRequest),
      setup: pick((r) => t(r).setupMs),
      conn: pick((r) => t(r).connectionsMs),
      tools: pick((r) => t(r).toolsMs),
      prep: pick((r) => t(r).streamPreparationMs),
      claim: pick((r) => Number(t(r).claim)),
      broker: pick((r) => Number(t(r).brokerStart)),
      connect: pick((r) => Number(t(r).sessionConnect)),
      firstText: pick((r) => t(r).firstTextMs),
      finClose: pick((r) => r.browser?.finishToClose),
    };
    console.log(`    ${label.padEnd(14)} ${Object.entries(stages).map(([k, v]) => `${k}=${v ?? "-"}`).join(" ")}`);
  }
  if (labels.length === 2) {
    const [a, b] = labels;
    const byPair = (label) => new Map(byLabel.get(label).filter((r) => r.ok && r.browser?.[metric] != null).map((r) => [r.pair, r.browser[metric]]));
    const pa = byPair(a);
    const pb = byPair(b);
    const deltas = [...pa.keys()].filter((p) => pb.has(p)).map((p) => pb.get(p) - pa.get(p));
    console.log(`  paired ${b} − ${a}: n=${deltas.length} median=${s(median(deltas))}s range=${deltas.length ? `${s(Math.min(...deltas))}…${s(Math.max(...deltas))}` : "-"}s`);
  }
}
