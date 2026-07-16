/**
 * Turn an agent-authored server draft into the exact `ServerFormData` the
 * Add-server form would have produced.
 *
 * A shared adapter rather than an object literal at the call site, because
 * "what the form builds" is a real contract with non-obvious parts:
 *
 *   - New servers default to `authMethod: "auto"` — connect unauthenticated,
 *     upgrade to OAuth on a 401. Defaulting to anything else here would make
 *     an agent-added server behave unlike a hand-added one.
 *   - `secretPatch` is a dirty-tracking REPLACEMENT patch. Omitting it means
 *     env/headers never reach Convex, so a server added by chat would
 *     silently lose its headers. A draft has no hidden stored secrets, so we
 *     always emit it when there is anything to emit.
 *   - Validation is `validateServerFormData`, the save path's own gate, so a
 *     draft is rejected for exactly what a form entry would be rejected for
 *     (including the hosted-mode HTTPS rule) — with one addition: it does
 *     NOT check `name`, and the connect path doesn't either, so we do.
 */
import type { ServerFormData } from "@/shared/types";
import type { InspectorServerDraft } from "@/shared/inspector-command";
import { validateServerFormData } from "@/lib/server-form-validation";

/** Mirrors `use-server-form.ts`'s defaults for a NEW server. */
const DEFAULT_TRANSPORT = "http" as const;
const DEFAULT_AUTH_METHOD = "auto" as const;

export type ServerDraftResult =
  | { ok: true; formData: ServerFormData }
  | { ok: false; error: string };

export function serverDraftToFormData(
  draft: InspectorServerDraft,
): ServerDraftResult {
  const name = draft.name?.trim();
  if (!name) {
    return { ok: false, error: "Server name is required." };
  }

  const transport = draft.transport ?? DEFAULT_TRANSPORT;
  if (transport !== "http" && transport !== "stdio") {
    return {
      ok: false,
      error: `Unknown transport "${transport}". Use "http" or "stdio".`,
    };
  }

  const headers = draft.headers;
  const env = draft.env;

  // Reject fields that belong to the other transport instead of silently
  // dropping them: a draft with a url AND a command is a misunderstanding
  // worth telling the model about.
  if (transport === "http" && (draft.command || draft.args?.length)) {
    return {
      ok: false,
      error: "HTTP servers take a url, not a command/args. Use transport 'stdio' for a command.",
    };
  }
  if (transport === "stdio" && draft.url) {
    return {
      ok: false,
      error: "STDIO servers take a command, not a url. Use transport 'http' for a url.",
    };
  }
  if (transport === "http" && env) {
    return {
      ok: false,
      error: "env applies to STDIO servers. Use headers for an HTTP server.",
    };
  }
  if (transport === "stdio" && headers) {
    return {
      ok: false,
      error: "headers apply to HTTP servers. Use env for a STDIO server.",
    };
  }

  const formData: ServerFormData = {
    name,
    type: transport,
    authMethod: DEFAULT_AUTH_METHOD,
    ...(transport === "http"
      ? {
          url: draft.url?.trim() ?? "",
          ...(headers ? { headers, secretPatch: { headers } } : {}),
        }
      : {
          command: draft.command?.trim() ?? "",
          args: draft.args ?? [],
          ...(env ? { env, secretPatch: { env } } : {}),
        }),
  };

  const validationError = validateServerFormData(formData);
  if (validationError) {
    // Relayed verbatim: it's the same message the user would see, and it
    // tells the model exactly what to fix.
    return { ok: false, error: validationError };
  }

  return { ok: true, formData };
}
