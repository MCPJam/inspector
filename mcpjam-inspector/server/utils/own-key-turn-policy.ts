/**
 * "Use your keys for all AI features" for a chat turn that runs on a key this
 * process holds: the request's own key, a local provider such as Ollama, or a
 * custom endpoint.
 *
 * Such a turn calls the provider from this process and never reaches the
 * backend, so the backend cannot refuse it, and the model picker is not a
 * guard. A local process or a personal key is no exemption from the policy,
 * so the turn reads it here the way an eval run on its own keys does
 * (`orgPolicyConfigForClientKeys`). While the organization that owns the
 * project requires its own keys, the turn is refused before anything reaches
 * the provider:
 * - a saved selection goes through `resolveLocalModelSelection` with
 *   `requireOrgKeys`, as an eval case's does (`resolveEvalSelectionRoute`);
 * - a turn with no saved selection, or a legacy one, also runs on a key on
 *   this machine and gets the same `org_keys_required` refusal.
 *
 * A turn with no project, or a build with no backend to ask, runs as before.
 * A policy read that fails refuses the turn as retryable
 * `ai_key_policy_unavailable`.
 *
 * An allowing answer is trusted for `OWN_KEY_POLICY_RECHECK_MS` from when it
 * was READ, not when it arrived: a policy change is enforced on the next
 * provider request after that window expires. A stream already running is not
 * interrupted. The answer is shared by every turn with the same authorization
 * scope (see `readPolicy`), because the backend's read budget is the user's,
 * not the turn's.
 */
import { wrapLanguageModel, type LanguageModel } from "ai";
import { isLegacySelection, type RequestedModelSelection } from "@mcpjam/sdk";
import { WebRouteError } from "../routes/web/errors.js";
import { orgPolicyConfigForClientKeys } from "../services/evals/org-policy-client-keys.js";
import { asAiRefusalRouteError } from "./ai-refusal-route-error.js";
import { githubExecutionPolicy } from "../services/github-checks/credential-policy.js";
import {
  ModelResolutionRefusalError,
  ORG_KEYS_REQUIRED_REASON,
  resolveLocalModelSelection,
  type ModelRefusal,
} from "./model-resolution-local.js";
import {
  buildCacheKey,
  type ResolveOrgModelConfigAuth,
  type ResolvedOrgModelConfig,
} from "./org-model-config.js";

export type OwnKeyTurn = {
  projectId: string | undefined;
  /** The turn's saved selection, when it has one. */
  selection: RequestedModelSelection | undefined;
  /** The provider the turn's model runs on (`ollama`, `custom`, ...). */
  provider: string;
  /** Whether the request carries its own key. */
  hasRequestKey: boolean;
  auth: ResolveOrgModelConfigAuth;
};

/**
 * The route error to answer instead of running the turn, or `undefined` when
 * the turn may run on its own key.
 */
export async function ownKeyTurnRefusal(
  turn: OwnKeyTurn,
): Promise<WebRouteError | undefined> {
  return (await ownKeyTurnCheck(turn)).refusal;
}

/**
 * The turn's refusal, or the `performance.now()` its allowing answer was read
 * at (`undefined` when nothing needed reading). A caller that wraps the turn's
 * model hands that `readAt` to `withOwnKeyTurnPolicy` as `allowedAt`: an answer
 * shared with other turns can be up to `OWN_KEY_POLICY_RECHECK_MS` older than
 * the call that received it.
 */
export async function ownKeyTurnCheck(
  turn: OwnKeyTurn,
): Promise<{ refusal: WebRouteError | undefined; readAt?: number }> {
  if (!turn.projectId) return { refusal: undefined };
  let read: PolicyRead;
  try {
    read = await readPolicy(turn, turn.projectId);
  } catch (error) {
    // The policy could not be read: fail closed with its retryable answer.
    if (error instanceof WebRouteError) return { refusal: error };
    throw error;
  }
  if (!read.orgConfig) return { refusal: undefined, readAt: read.startedAt };
  const refusal = new ModelResolutionRefusalError(
    ownKeyRefusals(turn, read.orgConfig),
  );
  return { refusal: asAiRefusalRouteError(refusal) ?? undefined };
}

type PolicyRead = {
  /** Set only while the organization requires its own keys. */
  orgConfig: ResolvedOrgModelConfig | undefined;
  /** `performance.now()` when the read STARTED. */
  startedAt: number;
};

/**
 * Allowing answers by authorization scope, as the `performance.now()` their
 * read started. Only the permission is kept: no provider secret, and no
 * refusal (a refusal depends on the turn's selection, and a failed or
 * refusing read must never become a trusted allow). Hits do not renew an
 * entry, so it lapses `OWN_KEY_POLICY_RECHECK_MS` after its read started.
 */
const allowedScopes = new Map<string, number>();
/** One read in flight per scope: concurrent turns wait on it. */
const scopeReads = new Map<string, Promise<PolicyRead>>();
const MAX_ALLOWED_SCOPES = 500;

function policyScope(turn: OwnKeyTurn, projectId: string): string | undefined {
  const backend = process.env.CONVEX_HTTP_URL;
  // No backend means nothing to read. A GitHub-scoped execution keeps its
  // reads unshared, as `resolveOrgModelConfig` keeps them uncached.
  if (!backend || githubExecutionPolicy()) return undefined;
  return `${backend}|${buildCacheKey({ projectId }, turn.auth)}`;
}

async function readPolicyFresh(
  turn: OwnKeyTurn,
  projectId: string,
): Promise<PolicyRead> {
  const startedAt = performance.now();
  const orgConfig = await orgPolicyConfigForClientKeys(
    { projectId },
    turn.auth,
  );
  return { orgConfig, startedAt };
}

/**
 * The policy for the turn's scope. Every compare model, parallel chat and new
 * turn of one user on one project shares the answer and the read, including
 * the chat route's pre-flight: the backend allows each user 60 reads a minute,
 * and per-turn windows spent it once enough turns were active.
 */
async function readPolicy(
  turn: OwnKeyTurn,
  projectId: string,
): Promise<PolicyRead> {
  const scope = policyScope(turn, projectId);
  if (scope === undefined) return readPolicyFresh(turn, projectId);

  const allowedAt = allowedScopes.get(scope);
  if (allowedAt !== undefined) {
    if (performance.now() - allowedAt < OWN_KEY_POLICY_RECHECK_MS) {
      return { orgConfig: undefined, startedAt: allowedAt };
    }
    allowedScopes.delete(scope);
  }

  let reading = scopeReads.get(scope);
  if (!reading) {
    reading = readPolicyFresh(turn, projectId)
      .then((read) => {
        if (!read.orgConfig) rememberAllowed(scope, read.startedAt);
        return read;
      })
      .finally(() => {
        scopeReads.delete(scope);
      });
    scopeReads.set(scope, reading);
  }
  return reading;
}

function rememberAllowed(scope: string, startedAt: number) {
  const now = performance.now();
  for (const [key, at] of allowedScopes) {
    const age = now - at;
    if (age < 0 || age >= OWN_KEY_POLICY_RECHECK_MS) allowedScopes.delete(key);
  }
  // Re-inserted so the Map's order stays oldest first for the bound below.
  allowedScopes.delete(scope);
  allowedScopes.set(scope, startedAt);
  while (allowedScopes.size > MAX_ALLOWED_SCOPES) {
    const oldest = allowedScopes.keys().next().value;
    if (oldest === undefined) break;
    allowedScopes.delete(oldest);
  }
}

export function resetOwnKeyPolicyCacheForTests(): void {
  allowedScopes.clear();
  scopeReads.clear();
}

function ownKeyRefusals(
  turn: OwnKeyTurn,
  orgConfig: ResolvedOrgModelConfig,
): ModelRefusal[] {
  const { selection } = turn;
  if (selection && !isLegacySelection(selection)) {
    const result = resolveLocalModelSelection({
      selection,
      purpose: "chat",
      hasOrgTarget: true,
      orgProviders: orgConfig.providers,
      hasLocalKey: () => turn.hasRequestKey,
      requireOrgKeys: true,
    });
    if (!result.ok) return result.refusals;
  }
  // No saved selection (or one the resolver let through): the turn is still
  // about to run on a key on this machine.
  return [
    {
      code: "org_keys_required",
      reason: ORG_KEYS_REQUIRED_REASON,
      evidence: { rail: "direct", provider: turn.provider },
    },
  ];
}

/**
 * How long a turn trusts the policy answer it last read before a provider
 * request reads it again. A self-hosted Inspector reads the policy from the
 * backend's bearer-only route, which allows each user 60 reads a minute.
 * Reading before every tool-loop step spent that budget on a single
 * multi-model turn, and the next read's 429 refused the turn as
 * `ai_key_policy_unavailable`.
 */
export const OWN_KEY_POLICY_RECHECK_MS = 15_000;

/**
 * Re-read the policy before a retry or tool-loop provider request once the
 * last allowing answer is `OWN_KEY_POLICY_RECHECK_MS` old.
 *
 * The wrapped model remembers the answer it last trusted; past the window it
 * asks `readPolicy`, which answers from the scope's shared answer or read
 * when another turn of the same user and project already has one.
 *
 * `allowedAt` is when the read that let the turn run STARTED: the `readAt`
 * of the caller's own `ownKeyTurnCheck`. Not a time the caller takes itself,
 * which can be later than a shared read's start and would stretch the window
 * past a revocation. A check that is already stale when the model is wrapped
 * is read again before the first request.
 */
export function withOwnKeyTurnPolicy(
  model: LanguageModel,
  turn: OwnKeyTurn,
  options: { allowedAt?: number } = {},
) {
  if (typeof model === "string") {
    throw new Error("A local model must be an explicit provider model.");
  }
  // `performance.now()`, not `Date.now()`: a wall-clock step back (NTP, a
  // resumed VM) must not stretch how long an allowing answer is trusted.
  let allowedAt = options.allowedAt;
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) => {
        // A negative age means `allowedAt` came from another timebase (a
        // `Date.now()` passed by mistake); treat it as stale, never as fresh.
        const age =
          allowedAt === undefined ? undefined : performance.now() - allowedAt;
        if (age !== undefined && age >= 0 && age < OWN_KEY_POLICY_RECHECK_MS) {
          return params;
        }
        // Parallel requests share the scope's one read, and all of them date
        // its answer from when that read STARTED: a slow read must not
        // stretch the window by its own latency.
        const checkedAt = performance.now();
        const { refusal, readAt = checkedAt } = await ownKeyTurnCheck(turn);
        if (refusal) throw refusal;
        allowedAt = Math.max(allowedAt ?? readAt, readAt);
        return params;
      },
    },
  });
}
