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
 *
 * ── And one gate that is NOT about harnesses ───────────────────────────────
 * `checkEvalExecutionAdmission` runs for EVERY eval run, harness or emulated.
 * It cannot live inside the two above: both return `{ ok: true }` immediately
 * when the host selects no harness, which is the overwhelming majority of runs
 * — exactly the ones its rule is about.
 */
import { isHarness, type Harness } from "@mcpjam/sdk/host-config/internal";
import { readXaaEnterprisePolicy } from "@mcpjam/sdk";
import { getCanonicalModelId } from "@/shared/types";
import {
  checkHarnessRuntimeAvailable,
  type HarnessUnavailableKind,
} from "../../utils/harness/harness-availability.js";
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
 * A harness eval iteration runs on ONE disposable box — and a SUITE RUN is the
 * only surface that boots one.
 *
 * A single-case run passes `runId: null`, and both provisioning sites require a
 * run, so no box is ever booted for it. Without one, `runHarnessTurn` falls
 * through to `resolveHarnessSandbox` and runs on the acting member's PERSONAL
 * computer — stateful, shared, and belonging to a person rather than to the run.
 * That fallback is exactly what eval execution must never take, so the surface
 * is refused instead. Pinning an image would not help: the surface itself is
 * the constraint.
 */
function harnessNeedsSuiteRunReason(harness: Harness): string {
  const name = getHarnessAdapter(harness).displayName;
  return (
    `the ${name} harness runs each eval iteration on a fresh, disposable ` +
    "computer, and a single-case run never provisions one. Run this case as " +
    "part of a suite. There is deliberately no fallback to your personal " +
    "computer: it is shared and stateful, and a run nobody pointed at it " +
    "must not put it to work."
  );
}

/**
 * A harness run needs a PROJECT: the box it runs on is provisioned and billed
 * against one.
 *
 * An org-level suite has no project, and `runHarnessTurn` discovers that only
 * once it tries to resolve the computer — mid-iteration, after the sandbox has
 * been booted and charged. Refusing at admission makes it a pre-flight failure
 * that spends nothing and says what to change.
 */
function harnessNeedsProjectReason(harness: Harness): string {
  const name = getHarnessAdapter(harness).displayName;
  return (
    `the ${name} harness runs each eval iteration on a computer provisioned ` +
    "against a project, and this suite is scoped to the organization rather " +
    "than to a project. Move the suite into a project (or run it on a " +
    "non-harness host) and retry."
  );
}

/**
 * A harness lease is authorized against the model the run PINNED, matched
 * byte-exact — so the pinned spelling has to be the one the runtime will ask
 * for.
 *
 * Names both forms, because the author's next action is a one-field edit and
 * guessing which of their models is wrong is the expensive part.
 */
function harnessNeedsCanonicalModelReason(
  harness: Harness,
  byRaw: ReadonlyMap<string, string>
): string {
  const name = getHarnessAdapter(harness).displayName;
  const pairs = [...byRaw.entries()]
    .slice(0, 10)
    .map(([raw, canonical]) => `"${raw}" → "${canonical}"`)
    .join(", ");
  const more = byRaw.size > 10 ? `, +${byRaw.size - 10} more` : "";
  return (
    `the ${name} harness leases model credentials against the model id this ` +
    "run pinned, and these cases pin a short form that the runtime resolves " +
    "to a different string — the lease would be refused mid-run, after the " +
    "iteration's box had already started. Save the case with the full id " +
    `instead: ${pairs}${more}`
  );
}

/**
 * `widgetRendered` needs the inspector's own widget manager to observe the
 * tool call — and a harness reaches MCP through the signed proxy instead, so
 * the manager never sees it and the assertion has nothing to watch.
 *
 * REFUSED at admission rather than skipped at grade time: a skipped assertion
 * on a passing run is indistinguishable from one that held, which is the same
 * false green this whole gate exists to prevent.
 */
function harnessCannotObserveWidgetsReason(
  harness: Harness,
  caseTitles: readonly string[]
): string {
  const name = getHarnessAdapter(harness).displayName;
  const named = caseTitles.slice(0, 10).join(", ");
  return (
    `the ${name} harness reaches MCP servers through a signed proxy rather ` +
    "than through the inspector, so widgetRendered assertions have nothing to " +
    "observe on a harness run. Remove them, or run these cases on a " +
    `non-harness host. Cases asserting widgetRendered: ${named}` +
    (caseTitles.length > 10 ? `, +${caseTitles.length - 10} more` : "")
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
/**
 * Whether a run reaches ANY MCP server — the input the approval gate keys off.
 *
 * Its own function, and exported, because it is the rule rather than an
 * expression: PLUGIN-contributed servers count, so a host whose servers come
 * solely from a pinned plugin version cannot slip a gate that only looked at
 * the explicitly-selected set. Both admission paths call this so the two can't
 * drift, and it stays directly testable no matter which harnesses happen to
 * refuse on the surface today — a caller inlining the `serverIds`-only half is
 * the bug this exists to prevent.
 */
export function hasSelectedMcpServersForAdmission(args: {
  serverIds?: readonly string[];
  pluginServerIds?: readonly string[];
}): boolean {
  return (
    (args.serverIds?.length ?? 0) > 0 ||
    (args.pluginServerIds?.length ?? 0) > 0
  );
}

export function checkEvalHarnessStaticAdmission(args: {
  hostConfig: Record<string, unknown> | null | undefined;
  /** The run's resolved server set (the manager connects exactly this). */
  serverIds?: readonly string[];
  /** Servers contributed by the environment's pinned plugin versions. They
   *  COUNT: a host whose MCP servers come solely from a plugin would otherwise
   *  slip the approval gate this exists to close. */
  pluginServerIds?: readonly string[];
}): EvalHarnessAdmission {
  const harness = harnessOfHostConfig(args.hostConfig);
  if (!harness) return { ok: true };
  const hostConfig = args.hostConfig as Record<string, unknown>;

  const hasSelectedMcpServers = hasSelectedMcpServersForAdmission(args);

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
    // The same id again, under the name the external-account rule reads. It is
    // not redundant on the FULL check below, where `model` becomes a per-case
    // model and this stays the host's — an external-account host must carry the
    // sentinel whatever a case asks for.
    ...(hostModelId ? { hostModelId } : {}),
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
    if (!hostModelId && isModelKind(availability.kind)) {
      return { ok: true, harness };
    }
    return { ok: false, harness, reason: availability.reason };
  }
  return { ok: true, harness };
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
  /**
   * Titles of cases asserting `widgetRendered`. A harness reaches MCP through
   * the signed proxy, so the inspector's widget manager never sees those calls.
   */
  widgetAssertingCaseTitles?: readonly string[];
  /**
   * The project this run bills and provisions against, when it has one.
   *
   * An ORG-LEVEL suite has none. `runHarnessTurn` needs a projectId to resolve
   * the box and throws without one — mid-iteration, AFTER the box has already
   * been booted and paid for. Refusing here turns that into a pre-flight
   * refusal that costs nothing and names the reason.
   *
   * OMITTED means "not resolved here", NOT "absent" — the same discipline
   * `pinnedComputerImageId` uses on the static half. An explicit `null` is a
   * resolved absence and refuses; that is what the run route passes.
   */
  projectId?: string | null;
}): EvalHarnessAdmission {
  const harness = harnessOfHostConfig(args.hostConfig);
  if (!harness) return { ok: true };
  const hostConfig = args.hostConfig as Record<string, unknown>;

  const hasSelectedMcpServers = hasSelectedMcpServersForAdmission(args);
  const xaaEnterprisePolicyOn =
    readXaaEnterprisePolicy(hostConfig.mcpProfile).kind !== "off";
  const requireToolApproval = hostConfig.requireToolApproval === true;
  // Read once for the external-account rule below. Absent ⇒ the host pinned no
  // model, and the gate holds the case's own model to the rule instead.
  const fullCheckHostModelId =
    typeof hostConfig.modelId === "string" && hostConfig.modelId.trim()
      ? hostConfig.modelId.trim()
      : undefined;

  // Model-bearing cases only. A model-free case runs pinned tool calls with no
  // runtime at all, so gating it on model eligibility would refuse a suite for
  // a model it never uses.
  const modelCases = args.cases.filter((test) => !isModelFreeCase(test));

  // Deduplicate by resolved model so a 40-case suite on one model makes one
  // decision, and so the ineligible-case list below stays about CASES.
  const ineligible: Array<{
    title: string;
    reason: string;
    kind: HarnessUnavailableKind;
  }> = [];
  const verdictByModel = new Map<
    string,
    { reason: string; kind: HarnessUnavailableKind } | undefined
  >();
  for (const test of modelCases) {
    const key = `${test.provider ?? ""}::${test.model}`;
    let verdict = verdictByModel.get(key);
    if (!verdictByModel.has(key)) {
      const availability = checkHarnessRuntimeAvailable({
        harnessId: harness,
        requireToolApproval,
        hasSelectedMcpServers,
        model: {
          id: String(test.model),
          ...(test.provider ? { provider: test.provider } : {}),
        },
        // The HOST's id, not the case's: the external-account rule is about
        // this host carrying the runtime's sentinel, and a case model can no
        // more answer that than a request body can.
        ...(fullCheckHostModelId ? { hostModelId: fullCheckHostModelId } : {}),
        xaaEnterprisePolicyOn,
      });
      verdict = availability.ok
        ? undefined
        : { reason: availability.reason, kind: availability.kind };
      verdictByModel.set(key, verdict);
    }
    if (verdict) {
      ineligible.push({
        title: test.title?.trim() || "(untitled case)",
        ...verdict,
      });
    }
  }

  if (ineligible.length > 0) {
    // Non-model refusals (approval, MCP support, broker delivery, enterprise
    // policy) are properties of the HOST and identical for every case — report
    // one of them plainly rather than repeating it per case.
    const hostLevel = ineligible.find((entry) => !isModelKind(entry.kind));
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

  // ── The pinned model must ALREADY be canonical ─────────────────────────
  //
  // The backend pins each iteration's host config from the case's model string
  // VERBATIM, while `runHarnessTurn` canonicalizes before asking the broker for
  // a lease (a bare `claude-sonnet-4-6` becomes `anthropic/claude-sonnet-4-6`,
  // which is the form the adapter's native mapping and the pricing table
  // understand). The broker's eval authorizer then compares the two BYTE-EXACT
  // — deliberately, because a lease is a spending authorization and a loose
  // match would let a box authorize a model its run never pinned.
  //
  // So a case whose stored model is not already canonical passes every check
  // above, boots a PAID box, and only then dies at broker start with a
  // deliberately opaque 403. Refuse it here instead, and name the id to store:
  // the two spellings are the same model, so the fix is a re-save, not a
  // different suite.
  //
  // Harness-only, and only until the case write paths normalize on save (the
  // durable fix). An emulated run never asks for a lease, so a non-canonical id
  // there is harmless and must not be refused.
  const nonCanonical = new Map<string, string>();
  for (const test of modelCases) {
    const raw = String(test.model);
    const canonical = getCanonicalModelId(raw, test.provider);
    if (canonical !== raw) nonCanonical.set(raw, canonical);
  }
  if (nonCanonical.size > 0) {
    return {
      ok: false,
      harness,
      reason: harnessNeedsCanonicalModelReason(harness, nonCanonical),
    };
  }

  // No model-bearing case at all: the host-level rules still apply, so run the
  // static half to decide them rather than admitting by default.
  if (modelCases.length === 0) {
    const staticOnly = checkEvalHarnessStaticAdmission({
      hostConfig: args.hostConfig,
      ...(args.serverIds ? { serverIds: args.serverIds } : {}),
      ...(args.pluginServerIds
        ? { pluginServerIds: args.pluginServerIds }
        : {}),
    });
    if (!staticOnly.ok) return staticOnly;
  }

  return admitHarness(harness, {
    // Passed THROUGH, never coerced: a caller may legitimately not know the
    // project, and refusing over a fact we do not hold is the same mistake as
    // admitting over one we do. The route passes an explicit `null` for an
    // org-level suite, which is what refuses.
    ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
    ...(args.widgetAssertingCaseTitles
      ? { widgetAssertingCaseTitles: args.widgetAssertingCaseTitles }
      : {}),
  });
}

/**
 * Built-in tool ids the inspector implements as COMPUTER-BACKED.
 *
 * The catalog's `requiresComputer` flag is authoritative for availability, but
 * it omits disabled rows and is not readable from here without a Convex round
 * trip that this synchronous gate has no business making. So this mirrors the
 * server resolver's own hardcoded floor (`BASH_TOOL_NAME` in
 * `utils/built-in-tools/registry.ts`) and the client's
 * `KNOWN_COMPUTER_BACKED_TOOL_IDS`. Under-listing here is the safe direction:
 * a tool we fail to name is admitted, which is today's behavior.
 */
const COMPUTER_BACKED_BUILT_IN_TOOL_IDS: ReadonlySet<string> = new Set([
  "bash",
]);

/**
 * Admission for EVERY eval run — harness or emulated.
 *
 * ONE rule today: a host that asks for a computer-backed built-in (`bash`)
 * cannot run when the environment pins no computer image.
 *
 * The failure it removes is a warn-and-skip. `resolveHostTools` logs
 * "bash requested without a computer attached; skipping" and continues, so the
 * run executes with the tool silently absent: the model never gets a shell, the
 * cases that needed one fail for reasons that look like model behavior, and a
 * suite whose cases do not depend on it reports GREEN for a host configuration
 * that never existed. A server log is not a result — nobody reading the run
 * sees it.
 *
 * Deliberately a REFUSAL rather than a degraded run, for the same reason the
 * harness gate is: the honest answer to "I cannot give you what this host asks
 * for" is to say so before spending, not to run something else and report on it.
 *
 * NOT part of the harness checks. `checkEvalHarnessAdmission` and its static
 * half both return `{ ok: true }` on their first line when no harness is
 * selected, so a rule placed there would never fire for an emulated run — and
 * emulated runs are precisely the ones this is about.
 *
 * A HARNESS run is exempt on the run surface: it provisions its own disposable
 * box whether or not an image is pinned, so the premise of the rule ("there
 * will be no computer") is simply false for it. It is refused on the
 * single-case surface instead, where no box is booted at all.
 */
export function checkEvalExecutionAdmission(args: {
  hostConfig: Record<string, unknown> | null | undefined;
  /**
   * The environment's pinned computer image; `null`/absent means none.
   *
   * Unlike the harness static half, absent is treated as ABSENT rather than
   * "not looked up": every caller of this gate resolves the run's frozen
   * environment first, so there is no "did not look" case to protect.
   *
   * IGNORED when `surface` is `"single-case"` — that surface can never attach
   * a computer regardless of what any environment pins.
   */
  pinnedComputerImageId?: string | null;
  /**
   * Which execution surface is asking.
   *
   * `"run"` (default) — a suite run. It provisions a box per iteration when the
   * run's environment pins an image, so an image is exactly what it lacks.
   *
   * `"single-case"` — a quick or streamed one-off. These pass `runId: null`,
   * and BOTH provisioning sites require `runId !== null`, so no box is ever
   * booted for them. That makes "pin an image" the wrong advice: pinning one
   * would change nothing. The surface itself is the constraint, so the refusal
   * has to say so and point at running the case in a suite instead.
   */
  surface?: "run" | "single-case";
}): { ok: true } | { ok: false; reason: string } {
  const singleCase = args.surface === "single-case";
  const harness = harnessOfHostConfig(args.hostConfig);

  // Checked BEFORE the built-in tool rule, and regardless of it: a harness on
  // this surface would run on the acting member's personal computer no matter
  // which tools the host grants.
  if (singleCase && harness) {
    return { ok: false, reason: harnessNeedsSuiteRunReason(harness) };
  }

  const ids = args.hostConfig?.builtInToolIds;
  if (!Array.isArray(ids) || ids.length === 0) return { ok: true };
  // A pinned image only helps the surface that can actually boot from it — and
  // a harness run boots a box with or without one.
  if (!singleCase && (args.pinnedComputerImageId || harness)) {
    return { ok: true };
  }

  const offending = ids.filter(
    (id): id is string =>
      typeof id === "string" && COMPUTER_BACKED_BUILT_IN_TOOL_IDS.has(id)
  );
  if (offending.length === 0) return { ok: true };

  const named = [...new Set(offending)].join(", ");
  const cause = singleCase
    ? "a single-case run never provisions a computer, so it cannot provide " +
      `${named} at all. Run this case as part of a suite whose environment ` +
      "pins a computer image"
    : "this run's environment pins no computer image. Pin one on the " +
      "environment (or attach an environment that does) and retry";
  return {
    ok: false,
    reason:
      `this host grants the computer-backed built-in ${named}, which needs a ` +
      `computer to run on, but ${cause}. The run was refused rather than ` +
      `executed with ${named} silently missing, which would have reported a ` +
      "result for a host configuration that never ran.",
  };
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

/**
 * Whether a refusal came from one of the gate's two MODEL rules — the only ones
 * whose answer depends on WHICH model was probed, and therefore the only ones
 * the static half must defer when it has no real model to probe with.
 *
 * Read off the gate's structured `kind`, never its wording: this used to match
 * the reason text, which made rephrasing a user-facing sentence silently change
 * which runs are admitted.
 */
function isModelKind(kind: HarnessUnavailableKind): boolean {
  return kind === "model-not-hosted" || kind === "model-unsupported";
}

/**
 * The last two rules, applied after every shared-gate rule has passed: the run
 * needs a project to provision and bill against, and none of its cases may
 * assert something a harness run cannot observe.
 *
 * A pinned computer image is deliberately NOT among them. It used to be
 * required outright, which on a deployment whose image builder is the inert
 * `stub` left harness evals with no working road at all — the only permitted
 * road was a custom image, and every image such a deployment can build boots a
 * template the model broker then refuses to lease against. An unpinned run now
 * boots the deployment-default template instead: still a fresh, disposable box
 * per iteration, just not a custom one. The invariant that survives is the one
 * that mattered — never the acting member's personal computer.
 */
function admitHarness(
  harness: Harness,
  args: {
    widgetAssertingCaseTitles?: readonly string[];
    /** `undefined` ⇒ the caller did not resolve one (the static half), so the
     *  rule is deferred to the full check rather than decided without evidence.
     *  An explicit `null` is a resolved absence and refuses. */
    projectId?: string | null;
  }
): EvalHarnessAdmission {
  if (args.projectId === null) {
    return {
      ok: false,
      harness,
      reason: harnessNeedsProjectReason(harness),
    };
  }
  const widgetCases = args.widgetAssertingCaseTitles ?? [];
  if (widgetCases.length > 0) {
    return {
      ok: false,
      harness,
      reason: harnessCannotObserveWidgetsReason(harness, widgetCases),
    };
  }
  return { ok: true, harness };
}
