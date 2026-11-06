import { isDeepStrictEqual } from "node:util";
import { readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";

export const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function matchSignature(config, history) {
  return digest({
    hostId: config.hostId,
    modelId: config.modelId,
    modelSelection: config.modelSelection ?? null,
    effort: config.effort ?? null,
    servers: [...config.serverIds].sort(),
    systemPrompt: config.systemPrompt ?? null,
    approval: false,
    history,
  });
}
export function cliSignature(actual, config, history) {
  for (const key of ["model", "effort", "systemPrompt"])
    if (
      JSON.stringify(actual[key] ?? null) !==
      JSON.stringify(config[key === "model" ? "nativeModel" : key] ?? null)
    )
      throw Error("Native CLI " + key + " differs from the matched profile.");
  if (
    JSON.stringify([...actual.serverNames].sort()) !==
    JSON.stringify(Object.keys(config.cliServers).sort())
  )
    throw Error("Native CLI server configuration differs.");
  return matchSignature(config, history);
}
export async function readEvidence(file, manifestHash) {
  try {
    const row = JSON.parse(await readFile(file, "utf8"));
    if (row.manifestHash !== manifestHash)
      throw Error("Existing measurements belong to another run configuration.");
    return row;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export async function saveEvidence(file, row) {
  await writeFile(file + ".tmp", JSON.stringify(row, null, 2));
  await rename(file + ".tmp", file);
}
export async function cleanupAll(jobs) {
  const results = await Promise.allSettled(
    jobs.map((fn) => Promise.resolve().then(fn)),
  );
  const errors = results
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason);
  if (errors.length)
    throw new AggregateError(
      errors,
      "Some benchmark resources could not be retired.",
    );
}

// Stop taking new work after a worker fails, but finish cleanup for every
// already-running pair before the caller closes its shared browser connection.
export async function runConcurrent(items, limit, work) {
  const queue = [...items];
  let failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: limit }, async () => {
      for (;;) {
        if (failed) return;
        const item = queue.shift();
        if (!item) return;
        try {
          await work(item);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const errors = results
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason);
  if (errors.length)
    throw new AggregateError(errors, "Benchmark batch stopped.");
}

export function requestMatch(body, expected, history) {
  if (
    body.projectId !== expected.projectId ||
    body.hostId !== expected.hostId ||
    body.model?.id !== expected.modelId ||
    body.scenarioId ||
    body.directVisibility === "shared"
  )
    throw Error(
      "The benchmark must use its private QA project, host and model.",
    );
  for (const [key, value] of Object.entries({
    reasoningEffort: expected.effort,
    systemPrompt: expected.systemPrompt,
    modelSelection: expected.modelSelection,
    requireToolApproval: false,
  }))
    if (!isDeepStrictEqual(body[key] ?? null, value ?? null))
      throw Object.assign(
        Error(
          "The effective " +
            key +
            " differs from the matched CLI configuration.",
        ),
        key === "modelSelection" ? { actual: body[key], expected: value } : {},
      );
  if (
    JSON.stringify([...(body.selectedServerIds ?? [])].sort()) !==
    JSON.stringify([...expected.serverIds].sort())
  )
    throw Error("The benchmark's connected servers changed.");
  const actual = body.messages.map(({ role, parts }) => [
    role,
    parts
      .map((p) => {
        if (p.type === "text") return p.text;
        if (["step-start", "reasoning"].includes(p.type)) return "";
        throw Error("The priming history contains non-text state.");
      })
      .join(""),
  ]);
  if (JSON.stringify(actual) !== JSON.stringify(history))
    throw Error("Priming histories differ.");
  return matchSignature(expected, history);
}

// A quick error paragraph or an unexecuted tool card is not a successful turn.
export function validateOutput(sample, workload, toolCalls) {
  if (sample.failed) return sample;
  const valid =
    workload === "text"
      ? sample.output.trim() === "MEASURED" && toolCalls === 0
      : toolCalls === 1;
  return valid
    ? sample
    : {
        ...sample,
        failed: true,
        reason: "The fixture outcome did not match the requested workload.",
      };
}

export function assertFollowupWindow(elapsed, window) {
  const [min, max] = window === "short" ? [30000, 90000] : [300000, 600000];
  if (!Number.isFinite(elapsed) || elapsed < min || elapsed > max)
    throw Error("Follow-up outside assigned window");
}

export async function fixtureSnapshot(url, request = fetch) {
  try {
    const response = await request(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error("Fixture statistics request failed.");
    const value = await response.json();
    if (
      !Number.isSafeInteger(value?.calls?.read_note) ||
      value.calls.read_note < 0 ||
      !Array.isArray(value.methods) ||
      !value.methods.every((event) => typeof event?.method === "string")
    )
      throw Error("Fixture statistics are invalid.");
    return value;
  } catch (error) {
    throw Object.assign(error, { protocolFailure: true });
  }
}

export function failedMeasurement(sample, error) {
  return {
    ...sample,
    failed: true,
    ms: 60000,
    reason: error.message,
    submittedAt: sample.submittedAt ?? error.submittedAt,
    protocolFailure:
      sample.protocolFailure === true || error.protocolFailure === true,
  };
}
