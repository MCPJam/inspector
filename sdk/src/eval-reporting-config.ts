import type { MCPJamReportingConfig } from "./eval-reporting-types.js";
import { resolveEvalCiMetadata } from "./eval-ci.js";

import { detectEvalGitMetadata } from "./eval-git.js";

export const AUTO_CI = Symbol("automaticExpandedCi");
const DISCOVERY = Symbol("gitDiscoveryEnabled");
const NORMALIZED = Symbol("normalizedEvalReportingConfig");

/** A total inventory: adding a public option requires choosing its boundary. */
export const REPORTING_CONFIG_FIELDS = {
  selectedClient: "wire",
  enabled: "local",
  terminalStatus: "local",
  transport: "local",
  apiKey: "local",
  baseUrl: "local",
  project: "path",
  strict: "local",
  failOnToolError: "local",
  host: "host",
  serverNames: "wire",
  serverReplayConfigs: "wire",
  suiteName: "wire",
  suiteDescription: "wire",
  notes: "wire",
  passCriteria: "wire",
  externalRunId: "wire",
  runGroupId: "wire",
  framework: "wire",
  ci: "wire",
  expectedIterations: "wire",
  tags: "wire",
  evaluationConfigHash: "wire",
  verdictPolicy: "wire",
  runEvaluations: "local",
  runName: "wire",
  runTags: "wire",
  runMetadata: "wire",
} as const satisfies Record<
  keyof MCPJamReportingConfig,
  "local" | "path" | "wire" | "host"
>;

function fail(field: string): never {
  throw new TypeError(`Invalid eval reporting ${field}`);
}

export function normalizeReportingConfig<T extends MCPJamReportingConfig>(
  input: T,
  env: NodeJS.ProcessEnv = process.env
): T {
  if ((input as T & { [NORMALIZED]?: boolean })[NORMALIZED]) return input;
  if (
    input.terminalStatus !== undefined &&
    !["cancelled", "timed_out"].includes(input.terminalStatus)
  )
    fail("terminalStatus");
  if (input.runEvaluations) {
    const evaluations = input.runEvaluations;
    if (
      !Array.isArray(evaluations) ||
      evaluations.length > 1000 ||
      new TextEncoder().encode(JSON.stringify(evaluations)).length > 256 * 1024
    )
      fail("runEvaluations (maximum 1000 cases and 256 KiB)");
    for (const envelope of evaluations)
      if (
        envelope.schemaVersion !== 1 ||
        envelope.scope !== "case_run" ||
        !envelope.caseId ||
        envelope.evaluationConfig.definitions.length > 100 ||
        new TextEncoder().encode(JSON.stringify(envelope)).length > 64 * 1024
      )
        fail("runEvaluations envelope (maximum 100 evaluators and 64 KiB)");
  }
  if (
    input.runGroupId !== undefined &&
    (typeof input.runGroupId !== "string" ||
      !input.runGroupId.trim() ||
      input.runGroupId.length > 128)
  )
    fail("runGroupId (1-128 characters)");
  const runName = input.runName ?? env.MCPJAM_RUN_NAME;
  if (
    runName !== undefined &&
    (typeof runName !== "string" || runName.length > 200)
  )
    fail("runName (maximum 200 characters)");
  const tags = input.runTags ?? [];
  if (
    !Array.isArray(tags) ||
    tags.some((tag) => typeof tag !== "string" || tag.length > 64)
  )
    fail("runTags (strings of at most 64 characters)");
  const runTags = [
    ...new Set([
      ...tags,
      ...(env.MCPJAM_RUN_TAGS?.split(",") ?? [])
        .map((tag) => tag.trim())
        .filter(Boolean),
    ]),
  ];
  if (runTags.length > 32 || runTags.some((tag) => tag.length > 64))
    fail("runTags (maximum 32 tags)");
  let runMetadata = input.runMetadata;
  if (runMetadata === undefined && env.MCPJAM_RUN_METADATA) {
    try {
      runMetadata = JSON.parse(env.MCPJAM_RUN_METADATA);
    } catch {
      console.warn(
        "[mcpjam/sdk] Optional environment run metadata omitted: invalid JSON."
      );
    }
  }
  try {
    if (runMetadata !== undefined) {
      if (
        !runMetadata ||
        typeof runMetadata !== "object" ||
        Array.isArray(runMetadata)
      )
        fail("runMetadata (flat object required)");
      const entries = Object.entries(runMetadata);
      if (
        entries.length > 64 ||
        new TextEncoder().encode(JSON.stringify(runMetadata)).length > 16384 ||
        entries.some(
          ([key, value]) =>
            ["__proto__", "prototype", "constructor"].includes(key) ||
            !["string", "number", "boolean"].includes(typeof value) ||
            (typeof value === "number" && !Number.isFinite(value))
        )
      )
        fail("runMetadata (64 flat keys, 16 KiB, finite values)");
    }
  } catch (error) {
    if (input.runMetadata !== undefined) throw error;
    runMetadata = undefined;
    console.warn(
      "[mcpjam/sdk] Optional environment run metadata omitted: invalid shape or size."
    );
  }
  return {
    ...input,
    [NORMALIZED]: true,
    [DISCOVERY]:
      input.enabled !== false &&
      !(input.ci && Object.keys(input.ci).length === 0) &&
      !["0", "false"].includes(env.MCPJAM_CI_AUTODETECT ?? "") &&
      !["0", "false"].includes(env.MCPJAM_GIT_AUTODETECT ?? ""),
    ci: resolveEvalCiMetadata(input.ci, env),
    ...(runName !== undefined ? { runName } : {}),
    ...(runTags.length ? { runTags } : { runTags: undefined }),
    ...(runMetadata !== undefined ? { runMetadata: { ...runMetadata } } : {}),
  };
}

/** Shared by one-shot, start, and size estimation. Local controls never enter JSON. */
export function buildReportingBody(
  input: MCPJamReportingConfig
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(
    REPORTING_CONFIG_FIELDS
  ) as (keyof MCPJamReportingConfig)[]) {
    if (REPORTING_CONFIG_FIELDS[key] === "wire" && input[key] !== undefined)
      body[key] = input[key];
  }
  return body;
}

export function requiresRunMetadataCapability(
  input: MCPJamReportingConfig
): boolean {
  return (
    input.runName !== undefined ||
    !!input.runTags?.length ||
    input.runMetadata !== undefined ||
    input.ci?.dirty !== undefined ||
    input.ci?.pullRequestNumber !== undefined
  );
}

/** Async provenance is frozen once at the run/report boundary, before execution. */
export async function prepareReportingConfig<T extends MCPJamReportingConfig>(
  input: T
): Promise<T> {
  const normalized = normalizeReportingConfig(snapshotReportingInput(input));
  if (
    !(normalized as T & { [DISCOVERY]?: boolean })[DISCOVERY] ||
    !(normalized.apiKey ?? process.env.MCPJAM_API_KEY)?.trim()
  )
    return normalized;
  const git = await detectEvalGitMetadata({ signal: input.transport?.signal });
  const autoDirty =
    normalized.ci?.dirty === undefined && git.dirty !== undefined;
  return {
    ...normalized,
    [DISCOVERY]: false,
    [AUTO_CI]: autoDirty,
    ci: { ...git, ...normalized.ci },
  };
}

/** Clone all accepted wire evidence before the first await; keep only local callable surfaces. */
export function snapshotReportingInput<T extends MCPJamReportingConfig>(
  input: T
): T {
  const copy = { ...input };
  for (const key of Object.keys(
    REPORTING_CONFIG_FIELDS
  ) as (keyof MCPJamReportingConfig)[]) {
    if (REPORTING_CONFIG_FIELDS[key] === "wire" && input[key] !== undefined)
      (copy as Record<string, unknown>)[key] = structuredClone(input[key]);
  }
  if (input.runEvaluations)
    copy.runEvaluations = structuredClone(input.runEvaluations);
  if ("results" in input)
    (copy as Record<string, unknown>).results = structuredClone(input.results);
  if (input.transport) copy.transport = { ...input.transport };
  if (input.host) {
    const snapshot = structuredClone(input.host.toJSON());
    copy.host = {
      toJSON: () => structuredClone(snapshot),
    } as typeof input.host;
  }
  if (
    "executor" in input &&
    input.executor &&
    typeof input.executor === "object" &&
    "getHostSnapshot" in input.executor &&
    typeof input.executor.getHostSnapshot === "function"
  ) {
    try {
      const snapshot = structuredClone(input.executor.getHostSnapshot());
      (copy as Record<string, unknown>).executor = {
        getHostSnapshot: () => structuredClone(snapshot),
      };
    } catch (error) {
      // Preserve the established fail-soft host resolver without invoking the caller twice.
      (copy as Record<string, unknown>).executor = {
        getHostSnapshot: () => {
          throw error;
        },
      };
    }
  }
  return copy;
}
