/**
 * A fresh authorization before every provider attempt on an organization's
 * local runtime.
 *
 * On the local runtime this process calls the provider itself, with a key
 * `/stream/org/resolve` handed it, so the backend never sees those calls and
 * cannot refuse one. A model built once per turn would keep calling the
 * provider through the turn's later tool steps and the AI SDK's retries after
 * an admin turned on "Use your keys for all AI features" or turned the
 * connection off. The model returned here asks the backend again, uncached,
 * before every `doGenerate` and `doStream`, and runs that attempt on the
 * config the answer carries. A refusal, or no answer, fails the attempt
 * before anything reaches the provider.
 *
 * Each attempt costs one `/stream/org/resolve` round trip, with the policy on
 * or off: nothing short of asking tells this process the policy just changed.
 */
import { RetryError, wrapLanguageModel, type LanguageModel } from "ai";
import {
  assertOrgModelAllowed,
  buildOrgModelFromResolvedConfig,
} from "@mcpjam/sdk/model-factory";
import { recognizedAiRefusalCode } from "../../shared/ai-execution-refusal.js";
import {
  admitLocalOrgAttempt,
  type LocalOrgAttemptRequest,
} from "./org-runtime-admission.js";

type AttemptModel = ReturnType<typeof wrapLanguageModel>;

function asAttemptModel(model: LanguageModel): AttemptModel {
  if (typeof model === "string") {
    throw new Error("An organization model must be a model object, not an id");
  }
  // No middleware: only normalizes an older model to the current interface.
  return wrapLanguageModel({ model, middleware: [] });
}

/**
 * Wrap a model built from a local-runtime answer so each provider attempt is
 * authorized first. `model` supplies only what the AI SDK reads before a call
 * (provider name, model id, supported URLs); every call runs on a model built
 * from that attempt's own admission. `admission` is the answer's own
 * (`OrgProviderRuntimeLocal.admission`); without one, no attempt runs.
 */
export function admitEachLocalOrgAttempt(
  model: LanguageModel,
  admission: LocalOrgAttemptRequest | undefined,
  modelId: string,
): AttemptModel {
  const admittedModel = async (abortSignal: AbortSignal | undefined) => {
    if (!admission) {
      throw new Error(
        "This organization connection cannot be checked before the call, so nothing was sent to the provider.",
      );
    }
    const provider = await admitLocalOrgAttempt(admission, { abortSignal });
    assertOrgModelAllowed(provider, modelId);
    return asAttemptModel(buildOrgModelFromResolvedConfig(provider, modelId));
  };
  return wrapLanguageModel({
    model: asAttemptModel(model),
    middleware: {
      wrapGenerate: async ({ params }) =>
        (await admittedModel(params.abortSignal)).doGenerate(params),
      wrapStream: async ({ params }) =>
        (await admittedModel(params.abortSignal)).doStream(params),
    },
  });
}

/**
 * The refusal a failed attempt carries, as `{ code, message }`, also when the
 * AI SDK wrapped it in a `RetryError` (a retry that was refused). Lets the
 * chat stream answer with the code the browser keys its banner on.
 */
export function localOrgAttemptRefusal(
  error: unknown,
): { code: string; message: string } | undefined {
  const candidates = RetryError.isInstance(error)
    ? [error, error.lastError]
    : [error];
  for (const candidate of candidates) {
    if (!(candidate instanceof Error)) continue;
    const raw = (candidate as { code?: unknown }).code;
    const code =
      typeof raw === "string" ? recognizedAiRefusalCode(raw) : undefined;
    if (code) return { code, message: candidate.message };
  }
  return undefined;
}
