/**
 * Admission gate for eval runs whose resolved host config selects a HARNESS
 * (Claude Code | Codex) rather than the emulated engine.
 *
 * WHY THIS EXISTS. A host config carrying `harness` runs the REAL runtime in
 * chat (`routes/web/chat-v2.ts`) and in swarms (`sessionSimulation/
 * swarm-runner.ts`), both of which pre-flight `checkHarnessRuntimeAvailable`
 * and refuse rather than degrade. Eval runs forwarded `resolvedExecution.
 * harness` into `prepareChatV2` but never pre-flighted anything and never
 * supplied a `harnessMcpProxy` — and since an eval suite ALWAYS has servers,
 * `runHarnessTurn` could not have run even if it had been reached. The
 * observable result was a run that quietly executed on the emulated engine and
 * reported GREEN, which is the worst possible answer: the suite claims it
 * measured Claude Code and it measured something else.
 *
 * So: a harness-hosted eval run either passes the SAME gate chat and swarms
 * use, or it fails with the gate's reason. Never emulated, never silent.
 *
 * DELIBERATELY NOT A RE-DERIVED SUBSET. `checkHarnessRuntimeAvailable` is
 * called directly (the swarm-runner's own note at its call site is the
 * governing rationale): a rule added to the shared gate later must apply here
 * too, and calling the same function is the only way to guarantee that.
 *
 * TWO HALVES, because the batch-launch route needs one of them early:
 *   - `checkEvalHarnessAdmission` — the full decision, made once the run's
 *     cases (and therefore their models) are known.
 *   - `checkEvalHarnessStaticAdmission` — everything knowable from the host
 *     config alone, so `POST /eval-run-groups` can reject a bad target during
 *     its all-target dry run BEFORE any sibling starts spending.
 */
import { isHarness, type Harness } from "@mcpjam/sdk/host-config/internal";
import { readXaaEnterprisePolicy } from "@mcpjam/sdk";
import { checkHarnessRuntimeAvailable } from "../../utils/harness/harness-availability.js";
import { getHarnessAdapter } from "../../utils/harness/registry.js";

/**
 * `ok` means the run may proceed. `harness` is present when a harness was
 * selected at all — absent means the emulated engine, which is always
 * admissible and is what the vast majority of suites run.
 */
export type EvalHarnessAdmission =
  | { ok: true; harness?: Harness }
  | { ok: false; harness: Harness; reason: string };

/** The one case-shaped input the gate reads. Matches the recorder's
 *  `config.tests` rows, so callers pass those straight through. */
export interface EvalHarnessCase {
  title?: string;
  model?: string;
  provider?: string;
}

/**
 * Model sentinels the recorder emits for MODEL-FREE cases (a case whose steps
 * are all pinned tool calls). They never reach a model runtime, so they are
 * not evidence of an ineligible model and must not be gated as one.
 */
const MODEL_FREE_SENTINEL_PROVIDER = "none";

function isModelFreeCase(test: EvalHarnessCase): boolean {
  return (
    !test.model ||
    test.provider === MODEL_FREE_SENTINEL_PROVIDER ||
    test.model === "widget-probe"
  );
}

/** The host-level `harness` selector, or undefined for the emulated engine.
 *  Only a REGISTERED id counts — same membership test the execution-context
 *  resolver applies, so the two can never disagree about what a run runs. */
export function harnessOfHostConfig(
  hostConfig: Record<string, unknown> | null | undefined
): Harness | undefined {
  if (!hostConfig) return undefined;
  return isHarness(hostConfig.harness) ? hostConfig.harness : undefined;
}

/**
 * Until real harness execution lands, admission's LAST word for an otherwise
 * eligible harness host is a refusal — an honest one, naming the harness.
 *
 * This is the whole point of the gate shipping ahead of the execution work: a
 * silently-emulated green run is a lie, and an explicit "not yet" is not. A
 * suite that wants emulated execution keeps a non-harness host, the same
 * choice a chat user has.
 */
function harnessExecutionUnsupportedReason(harness: Harness): string {
  const name = getHarnessAdapter(harness).displayName;
  return (
    `eval runs cannot execute the ${name} harness yet — this suite's host ` +
    `selects ${name}, and running it on the emulated engine instead would ` +
    "report a result for a runtime that never ran. Point the suite at a host " +
    "without a harness to run emulated, or run this host in chat."
  );
}

/**
 * Everything the gate can decide from the HOST CONFIG and server set alone —
 * no case models required.
 *
 * Exported for `POST /eval-run-groups`: a fan-out must not start target 1
 * before target 2 has passed the checks that do not need a run row. The
 * per-case model rules stay in the full check, which runs at prepare time.
 */
export function checkEvalHarnessStaticAdmission(args: {
  hostConfig: Record<string, unknown> | null | undefined;
  /** The run's resolved server set (the manager connects exactly this). */
  serverIds?: readonly string[];
  /** Servers contributed by the environment's pinned plugin versions. They
   *  COUNT: a host whose MCP servers come solely from a plugin would otherwise
   *  slip the approval gate this exists to close. */
  pluginServerIds?: readonly string[];
  /**
   * Set by PR 6 once eval runs can actually drive a harness. Until then the
   * static half still refuses, so the batch route's dry run rejects a harness
   * target for the same reason the runner would.
   */
  allowHarnessExecution?: boolean;
}): EvalHarnessAdmission {
  const harness = harnessOfHostConfig(args.hostConfig);
  if (!harness) return { ok: true };
  const hostConfig = args.hostConfig as Record<string, unknown>;

  const hasSelectedMcpServers =
    (args.serverIds?.length ?? 0) > 0 ||
    (args.pluginServerIds?.length ?? 0) > 0;

  // A model is required by the shared gate's signature, but the per-case
  // models are not known yet on this path. Probe with the host's own pinned
  // model when it has one: every rule EXCEPT model eligibility is model
  // independent, and a host-pinned model is the one every case inherits unless
  // it overrides. With no pinned model, skip the model-derived rules here and
  // let the full check make that call.
  const hostModelId =
    typeof hostConfig.modelId === "string" && hostConfig.modelId.trim()
      ? hostConfig.modelId.trim()
      : undefined;

  const availability = checkHarnessRuntimeAvailable({
    harnessId: harness,
    requireToolApproval: hostConfig.requireToolApproval === true,
    hasSelectedMcpServers,
    // A blank probe id is deliberately NOT hosted-eligible, so skip the model
    // rules rather than fail on a model nobody named: `checkModelEligibility`
    // below owns that decision once the run's cases are known.
    model: { id: hostModelId ?? "" },
    // Same tri-state read the swarm gate makes: `invalid` is treated exactly
    // like `on`, because a malformed enterprise policy must never be MORE
    // permissive than a valid one.
    xaaEnterprisePolicyOn:
      readXaaEnterprisePolicy(hostConfig.mcpProfile).kind !== "off",
  });
  if (!availability.ok) {
    // With no host-pinned model, a model-eligibility refusal is about the
    // empty probe id and not about anything the caller configured. Suppress it
    // here; the full check re-runs the same gate with real case models.
    if (!hostModelId && isModelReason(availability.reason)) {
      return maybeUnsupported(harness, args.allowHarnessExecution);
    }
    return { ok: false, harness, reason: availability.reason };
  }
  return maybeUnsupported(harness, args.allowHarnessExecution);
}

/**
 * The full decision: static admission plus per-case model eligibility.
 *
 * Model eligibility is per case because a suite can mix models, and the honest
 * failure names the cases that cannot run — "some model is ineligible" sends
 * the author hunting through the suite.
 */
export function checkEvalHarnessAdmission(args: {
  hostConfig: Record<string, unknown> | null | undefined;
  serverIds?: readonly string[];
  pluginServerIds?: readonly string[];
  /** The run's snapshotted cases (the recorder's `config.tests`). */
  cases: ReadonlyArray<EvalHarnessCase>;
  allowHarnessExecution?: boolean;
}): EvalHarnessAdmission {
  const harness = harnessOfHostConfig(args.hostConfig);
  if (!harness) return { ok: true };
  const hostConfig = args.hostConfig as Record<string, unknown>;

  const hasSelectedMcpServers =
    (args.serverIds?.length ?? 0) > 0 ||
    (args.pluginServerIds?.length ?? 0) > 0;
  const xaaEnterprisePolicyOn =
    readXaaEnterprisePolicy(hostConfig.mcpProfile).kind !== "off";
  const requireToolApproval = hostConfig.requireToolApproval === true;

  // Model-bearing cases only. A model-free case runs pinned tool calls with no
  // runtime at all, so gating it on model eligibility would refuse a suite for
  // a model it never uses.
  const modelCases = args.cases.filter((test) => !isModelFreeCase(test));

  // Deduplicate by resolved model so a 40-case suite on one model makes one
  // decision, and so the ineligible-case list below stays about CASES.
  const ineligible: Array<{ title: string; reason: string }> = [];
  const verdictByModel = new Map<string, string | undefined>();
  for (const test of modelCases) {
    const key = `${test.provider ?? ""}::${test.model}`;
    let reason = verdictByModel.get(key);
    if (!verdictByModel.has(key)) {
      const availability = checkHarnessRuntimeAvailable({
        harnessId: harness,
        requireToolApproval,
        hasSelectedMcpServers,
        model: {
          id: String(test.model),
          ...(test.provider ? { provider: test.provider } : {}),
        },
        xaaEnterprisePolicyOn,
      });
      reason = availability.ok ? undefined : availability.reason;
      verdictByModel.set(key, reason);
    }
    if (reason) {
      ineligible.push({
        title: test.title?.trim() || "(untitled case)",
        reason,
      });
    }
  }

  if (ineligible.length > 0) {
    // Non-model refusals (approval, MCP support, broker delivery, enterprise
    // policy) are properties of the HOST and identical for every case — report
    // one of them plainly rather than repeating it per case.
    const hostLevel = ineligible.find((entry) => !isModelReason(entry.reason));
    if (hostLevel) {
      return { ok: false, harness, reason: hostLevel.reason };
    }
    const names = [...new Set(ineligible.map((entry) => entry.title))];
    return {
      ok: false,
      harness,
      reason: `${ineligible[0]!.reason}. Ineligible cases: ${names
        .slice(0, 10)
        .join(", ")}${names.length > 10 ? `, +${names.length - 10} more` : ""}`,
    };
  }

  // No model-bearing case at all: the host-level rules still apply, so run the
  // static half to decide them rather than admitting by default.
  if (modelCases.length === 0) {
    return checkEvalHarnessStaticAdmission({
      hostConfig: args.hostConfig,
      ...(args.serverIds ? { serverIds: args.serverIds } : {}),
      ...(args.pluginServerIds
        ? { pluginServerIds: args.pluginServerIds }
        : {}),
      ...(args.allowHarnessExecution !== undefined
        ? { allowHarnessExecution: args.allowHarnessExecution }
        : {}),
    });
  }

  return maybeUnsupported(harness, args.allowHarnessExecution);
}

/**
 * How the run's engine is ATTRIBUTED, forever after, on the run record.
 *
 * A run that says nothing about its engine is indistinguishable from one that
 * ran the harness, which is exactly the ambiguity that let silent emulation go
 * unnoticed. Stamped for every run, not just harness ones.
 */
export function executionEngineLabel(
  hostConfig: Record<string, unknown> | null | undefined
): string {
  const harness = harnessOfHostConfig(hostConfig);
  return harness ? `harness:${harness}` : "emulated";
}

/** Whether a refusal came from one of the gate's two MODEL rules — the only
 *  ones that depend on which model was probed. Matched on the shared gate's
 *  own wording; both of its model refusals name a model and nothing else does. */
function isModelReason(reason: string): boolean {
  return (
    reason.includes("only runs MCPJam-provided models") ||
    reason.includes("can't run this host's model")
  );
}

function maybeUnsupported(
  harness: Harness,
  allowHarnessExecution: boolean | undefined
): EvalHarnessAdmission {
  return allowHarnessExecution
    ? { ok: true, harness }
    : {
        ok: false,
        harness,
        reason: harnessExecutionUnsupportedReason(harness),
      };
}
