/**
 * The built-in web search's refusal under an organization's AI key policy
 * ("Use your keys for all AI features"). The Inspector server keeps the
 * backend's refusal code on the tool result (`{ error, code, remediation }`,
 * `server/utils/built-in-tools/exa-web-search.ts`); the tool card reads it
 * here and says why search is off, worded for whoever reads it.
 */
import {
  recognizedAiRefusalCode,
  type AiRefusalCode,
} from "@/shared/ai-execution-refusal";
import {
  describeOrgKeysRefusal,
  type AiRefusalAudience,
  type AiRefusalDescription,
} from "@/lib/org-keys-refusal";

export const WEB_SEARCH_TOOL_NAME = "web_search";

/**
 * The refusal code on a web search result, or `undefined` for any other tool
 * or result (a search that ran, or failed for another reason).
 */
export function webSearchRefusalCodeOf(
  toolName: string | undefined,
  output: unknown,
): AiRefusalCode | undefined {
  if (toolName !== WEB_SEARCH_TOOL_NAME) return undefined;
  if (!output || typeof output !== "object") return undefined;
  const code = (output as { code?: unknown }).code;
  return recognizedAiRefusalCode(typeof code === "string" ? code : undefined);
}

const TITLE = "Web search unavailable";

/**
 * What the tool card says about a refused search. Search runs on the
 * organization's model for background work, so the model codes read as the
 * organization's model to change, never as a pick.
 */
export function describeWebSearchRefusal(
  code: AiRefusalCode,
  audience: AiRefusalAudience,
): AiRefusalDescription {
  const described = describeOrgKeysRefusal(code, audience, "background");
  if (audience === "visitor") {
    return {
      title: TITLE,
      body: "Web search isn't available in this chat.",
      remediation: described.remediation,
    };
  }
  if (code === "org_runtime_unsupported") {
    return {
      title: "Web search is off",
      body: "Web search can't run on this organization's providers yet. Keep “Use your keys for all AI features” on and continue without Web Search.",
      remediation: described.remediation,
    };
  }
  return { ...described, title: TITLE };
}

/** The readiness the editor reads: the backend's row for `web_search`. */
type WebSearchReadiness = {
  requireOrgKeys?: boolean;
  operations?: ReadonlyArray<{ operation: string; status: string }>;
};

/**
 * The built-in tools editor's note on Web Search, or `undefined` when search
 * runs. Only while the organization requires its own keys and the backend
 * says search can't run under it; an older backend that reports no
 * `web_search` row still runs search, so it gets no note. The note never
 * blocks saving: the search itself, or a run's launch, is refused with the
 * reason.
 */
export function webSearchPolicyNote(
  readiness: WebSearchReadiness | undefined,
): string | undefined {
  if (!readiness?.requireOrgKeys) return undefined;
  const row = readiness.operations?.find(
    (entry) => entry.operation === WEB_SEARCH_TOOL_NAME,
  );
  if (!row || row.status === "ready" || row.status === "hosted") {
    return undefined;
  }
  return row.status === "unsupported"
    ? "Off while your organization requires its own AI keys. Web search can't run on them yet."
    : "Can't run on your organization's AI providers right now. Check Organization → AI providers.";
}
