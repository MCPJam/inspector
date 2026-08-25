/**
 * The pre-run disclosure a run proposal carries on its approval card
 * (Evals v2, Lane G, step G4d).
 *
 * G4b/G4c disclose a run to the person who LAUNCHES it. A proposal is the one
 * place where the person who launches it is not the person who chose it: the
 * agent picked the suite, and someone else is about to click "Run it" on a
 * card in Slack. This is what puts the same facts on that card.
 *
 * Three properties, none of them negotiable:
 *
 *  1. ONE RESOLUTION. The disclosure is fetched for the FROZEN proposal input
 *     — the object `normalizeProposalArgs` (`freezeEvalRunTargets`) returned,
 *     which is byte-for-byte what the approval route will execute. Never
 *     re-resolved from the raw selectors the model wrote: `allAttached: true`
 *     re-expands against whatever is attached at the time, so disclosing from
 *     it would describe a set the click may not run. The freeze already
 *     dropped `allAttached`; frozen ids re-resolving to themselves cannot
 *     widen.
 *  2. BEST-EFFORT, INDEPENDENTLY BOUNDED. This must never block, delay
 *     materially, or fail a mint. Its own short timeout, its own try/catch,
 *     and no client ⇒ skipped entirely — the same degrade the freeze itself
 *     already takes. On any failure the field is simply absent and the
 *     proposal mints exactly as it does today.
 *  3. ABSENCE IS UNKNOWN, NEVER SAFE. Nothing here ever substitutes a
 *     reassuring default for a fact it could not obtain. A summary that
 *     cannot name the engine omits `engine`; it does not say "emulated". The
 *     renderers carry the other half of this rule: absent field ⇒ render
 *     nothing.
 *
 * Going through `getEvalRunDisclosureOperation` rather than calling Convex is
 * deliberate. The operation self-dispatches through
 * `GET .../eval-suites/{id}/run-disclosure`, and that route asserts the
 * runner's capability handshake (`RUNNER_CAPABILITIES` — "TWO CALLERS, ONE
 * LIST"), composes `execution.locus`, and recomputes the digest. A direct
 * Convex read from the mint site would re-implement all three at a second
 * site, and the two would drift.
 */
import type {
  PlatformApiClient,
  PlatformEvalRunDisclosure,
} from "@mcpjam/sdk/platform";
import { getEvalRunDisclosureOperation } from "@mcpjam/sdk/platform";
import type { ProposedActionDisclosure } from "@mcpjam/sdk/public-api";
import { runEvalCaseOperation } from "@mcpjam/sdk/platform";
import { logger } from "../../utils/logger.js";

/**
 * Ceiling on the mint-time disclosure fetch, independent of the turn's own
 * deadline — the same rationale as the SDK's `boundedDisclosureSignal`, which
 * is module-private there.
 *
 * A mint is inside a model turn with a ~90s wall clock, and a proposal is
 * worth far more to the user than the line beneath it. Short enough that a
 * stalled backend costs the turn a blink rather than a tool call, and a single
 * lightweight GET to our own API has no business needing longer.
 */
const DISCLOSURE_MINT_TIMEOUT_MS = 3_000;

/** Read a trimmed non-empty string off validated-but-loosely-typed input. */
function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Read a list of non-empty strings; `[]` for anything else. */
function strList(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
}

/**
 * Map a FROZEN run-proposal input onto `get_eval_run_disclosure`'s input, or
 * refuse.
 *
 * The two vocabularies overlap but are not the same: a run says `case`
 * (singular) where the disclosure says `cases`, and a run can say `hosts`
 * where the disclosure has only `host`. Refusing is a first-class outcome
 * here — every `undefined` below is a plan the contract cannot answer for
 * honestly, and an honest absence beats a confident wrong answer.
 */
export function disclosureInputForProposal(
  operationName: string,
  input: Record<string, unknown>,
  /**
   * The project the click will run in — `persistProposal`'s own, which is what
   * gets persisted on the proposal row.
   *
   * NOT `input.project`, deliberately. The approval route executes
   * `{ ...claim.input, project: claim.projectId }` (`proposed-actions.ts`), so
   * the stored input's own `project` is overwritten at click time and is not
   * the authority on where the run lands. Both agree today — the gated tool
   * clamps `project` before validating — but keying the disclosure off the
   * value the click actually uses makes that structural rather than incidental,
   * and removes a refusal branch that would silently drop the disclosure if a
   * normalizer ever stopped carrying the key.
   */
  projectId: string,
): Record<string, unknown> | undefined {
  const project = projectId.trim();
  const suite = str(input, "suite");
  if (!project || !suite) return undefined;

  // COMPOSE is an ad-hoc target: models and a host the caller assembled for
  // this run alone, attached to nothing. The disclosure contract keys on the
  // suite's ATTACHED targets, so the only query available for a compose run
  // is the selector-less suite-base derivation — which the composed models
  // can flatly contradict. That is the exact failure G4c refused for the host
  // axis ("emulated, no sandbox" moments before a harness sandbox booted), so
  // refuse it here for the same reason rather than disclose the wrong plan.
  if (input.compose && typeof input.compose === "object") return undefined;

  // `allAttached` should have been dropped by `freezeEvalRunTargets`. Still
  // present means the freeze degraded (no client, an unresolvable suite) and
  // the target set is whatever is attached at CLICK time — unknown now, so
  // there is nothing honest to disclose.
  if (input.allAttached === true) return undefined;

  const hosts = strList(input, "hosts");
  // A multi-target host group has no single engine or model set to disclose:
  // the contract answers per launch plan and its one-axis rule refuses a host
  // alongside an environment. `getEvalRunDisclosureOperation` throws its own
  // one-plan refusal for this, and catching that would work — but the launch
  // path already recognises the shape up front (`isMultiTargetHostLaunch`),
  // and skipping a round trip we know the answer to is cheaper than a caught
  // throw.
  if (hosts.length > 1) return undefined;

  const host = str(input, "host") ?? hosts[0];
  const environment = str(input, "environment");
  const environments = strList(input, "environments");
  // The operation asserts these are coherent and throws otherwise. A run
  // input is validated coherent already, but the mapping above can only make
  // that worse, never better — bail rather than hand the operation a shape it
  // will reject.
  if (host && (environment || environments.length > 0)) return undefined;

  const cases =
    operationName === runEvalCaseOperation.name
      ? // A single-case run says `case`; the disclosure narrows by `cases`.
        (() => {
          const single = str(input, "case");
          return single ? [single] : [];
        })()
      : strList(input, "cases");

  return {
    project,
    suite,
    ...(cases.length > 0 ? { cases } : {}),
    ...(environment ? { environment } : {}),
    ...(environments.length > 0 ? { environments } : {}),
    ...(host ? { host } : {}),
  };
}

/** Dedupe, preserving first-appearance order. */
function dedupe(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * The vendor half of a judge's model id (`openai/gpt-5.4-mini` → `openai`).
 *
 * `undefined` when the id carries no vendor prefix — which makes the whole
 * `judgeProviders` field unknown rather than partially populated, because a
 * list that quietly dropped an unclassifiable judge would understate where
 * evidence goes.
 */
function judgeProviderOf(modelId: string): string | undefined {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return undefined;
  const vendor = modelId.slice(0, slash).trim();
  return vendor || undefined;
}

/**
 * Project the full contract down to what an approval card states.
 *
 * The rule for every field: state it only when the contract answered it.
 * `PlatformEvalRunDisclosure` distinguishes "no models" from "models not
 * derivable" (`modelsUnresolved`) and "did not execute" from "will execute,
 * unresolved" (`executionAbsence.kind`) precisely so a surface cannot collapse
 * them, and collapsing them HERE would put the reassuring half of each pair on
 * a card someone is about to click.
 */
export function summarizeDisclosure(
  disclosure: PlatformEvalRunDisclosure,
): ProposedActionDisclosure {
  const summary: ProposedActionDisclosure = { digest: disclosure.digest };
  const execution = disclosure.execution;

  // No `execution` section ⇒ engine, sandbox, providers and BYOK are all
  // UNKNOWN. Not "emulated", not "no sandbox", not "managed rail" — the two
  // `executionAbsence` kinds mean different things and neither of them means
  // "nothing leaves", so the card says nothing about execution at all.
  if (execution) {
    summary.engine = execution.engine;
    summary.sandbox = {
      engaged: execution.sandbox.engaged,
      ...(execution.sandbox.vendor ? { vendor: execution.sandbox.vendor } : {}),
    };
    // An empty `models` with `modelsUnresolved` means models WILL run and are
    // simply not derivable here. Publishing an empty provider list for that
    // would read as "nothing egresses", so the field stays absent — and so
    // does `byok`, which is a fact ABOUT those unresolved models.
    const resolvedModels = execution.modelsUnresolved
      ? undefined
      : execution.models;
    if (resolvedModels) {
      // ALL-OR-NOTHING. A `null` provider is the classifier declining, and a
      // list with that model silently missing would name fewer destinations
      // than the run actually reaches.
      const classified = resolvedModels.every(
        (model) => typeof model.provider === "string" && model.provider,
      );
      if (classified) {
        summary.runProviders = dedupe(
          resolvedModels.map((model) => model.provider as string),
        );
      }
      summary.byok = resolvedModels.some(
        (model) =>
          model.byok !== undefined ||
          model.tenantEgress === "byok-cloud" ||
          model.tenantEgress === "byok-local",
      );
    }
  }

  // Only touchpoints that CAN fire. A disabled one sends nothing, and listing
  // its provider would warn about egress that cannot happen — the mirror image
  // of the absence rule, and just as dishonest.
  const firing = disclosure.analysis.filter(
    (touchpoint) => typeof touchpoint.fires === "string",
  );
  if (firing.length > 0) {
    const providers = firing.map((touchpoint) =>
      judgeProviderOf(touchpoint.model),
    );
    if (providers.every((provider): provider is string => Boolean(provider))) {
      // "Different from the run's own" is the surprise worth stating; a judge
      // on a provider the run already reaches tells the approver nothing new.
      // When the run's own providers are UNKNOWN this subtracts nothing, so
      // every firing judge is listed — erring toward disclosing more, which is
      // the only direction a disclosure may err.
      const own = new Set(
        (summary.runProviders ?? []).map((provider) =>
          provider.toLocaleLowerCase(),
        ),
      );
      const extra = dedupe(providers).filter(
        (provider) => !own.has(provider.toLocaleLowerCase()),
      );
      if (extra.length > 0) summary.judgeProviders = extra;
    }
  }

  summary.retention = {
    policyDays: disclosure.retention.policyDays,
    // Straight from the contract, NEVER re-derived from `policyDays` — an
    // unenforced policy keeps data indefinitely whatever its number says.
    effectiveToday: disclosure.retention.effectiveToday,
  };
  return summary;
}

/**
 * Fetch and summarize the disclosure for one frozen run-proposal input.
 *
 * Returns `undefined` for every failure mode there is, and never throws: no
 * client, a plan the contract cannot answer for, a backend predating G4a's
 * query (`422 FEATURE_NOT_SUPPORTED`), a timeout, a transient error. The
 * caller mints regardless.
 */
export async function disclosureForProposal(opts: {
  operationName: string;
  /** The FROZEN input — what the click will execute. Never the raw input. */
  input: Record<string, unknown>;
  /** The project the click will run in. See `disclosureInputForProposal`. */
  projectId: string;
  client: PlatformApiClient;
}): Promise<ProposedActionDisclosure | undefined> {
  try {
    // Inside the try with the fetch, not before it. The mapping is pure
    // property reads behind type guards and cannot throw today — but "cannot
    // fail a mint" is the property, and a property that depends on nobody
    // adding a throw to a helper later is not one.
    const mapped = disclosureInputForProposal(
      opts.operationName,
      opts.input,
      opts.projectId,
    );
    if (!mapped) return undefined;
    const disclosure = await getEvalRunDisclosureOperation.execute(
      mapped as Parameters<typeof getEvalRunDisclosureOperation.execute>[0],
      {
        client: opts.client,
        // ITS OWN deadline. The turn's signal is not threaded in on purpose:
        // this fetch must be unable to consume budget the mint itself needs,
        // and a mint that already survived validation should not be lost to a
        // line of context beneath it.
        signal: AbortSignal.timeout(DISCLOSURE_MINT_TIMEOUT_MS),
      },
    );
    return summarizeDisclosure(disclosure);
  } catch (error) {
    // INFO, not error: an absent disclosure is a designed outcome of this
    // path, not a fault. A backend predating the contract answers 422 here on
    // every single mint, and paging on that would be noise.
    logger.info("[v1/agent] no pre-run disclosure for a run proposal", {
      operation: opts.operationName,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
