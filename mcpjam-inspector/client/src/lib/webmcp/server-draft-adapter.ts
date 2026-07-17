/**
 * Turn an agent-authored server draft into `ServerFormData`.
 *
 * Two entry points, because the two tools have opposite obligations:
 *
 *   - `serverDraftToFormData` — for `ui_add_server`, which SAVES. It builds
 *     the exact `ServerFormData` the Add form would, and validates it through
 *     the save path's own gate (`validateServerFormData`, incl. the hosted
 *     HTTPS rule), so a draft is rejected for exactly what a form entry would
 *     be. Plus `name`, which that validator doesn't check and the connect
 *     path doesn't either.
 *
 *   - `serverDraftToPrefill` — for `ui_open_server_form`, which OPENS the
 *     form for the user to finish. A blank or half-filled prefill is the
 *     normal case here, so it must NOT be validated as a complete config. It
 *     only shapes what's present into the form's field names.
 *
 * The form's real defaults matter for the save path: `authMethod: "auto"`
 * (connect unauthenticated, upgrade to OAuth on 401) so an agent-added server
 * behaves like a hand-added one. `env`/`headers` are deliberately absent from
 * the draft (they carry secrets and would reach the transcript) — the user
 * enters those in the form.
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

/** Shared shape check for both entry points. */
function resolveTransport(
  draft: Pick<InspectorServerDraft, "transport" | "command" | "args" | "url">,
): { ok: true; transport: "http" | "stdio" } | { ok: false; error: string } {
  const transport = draft.transport ?? DEFAULT_TRANSPORT;
  if (transport !== "http" && transport !== "stdio") {
    return {
      ok: false,
      error: `Unknown transport "${transport}". Use "http" or "stdio".`,
    };
  }
  // Reject fields that belong to the other transport rather than silently
  // dropping them: a draft with both a url and a command is a
  // misunderstanding worth telling the model about.
  if (transport === "http" && (draft.command || draft.args?.length)) {
    return {
      ok: false,
      error:
        "HTTP servers take a url, not a command/args. Use transport 'stdio' for a command.",
    };
  }
  if (transport === "stdio" && draft.url) {
    return {
      ok: false,
      error:
        "STDIO servers take a command, not a url. Use transport 'http' for a url.",
    };
  }
  return { ok: true, transport };
}

export function serverDraftToFormData(
  draft: InspectorServerDraft,
): ServerDraftResult {
  const name = draft.name?.trim();
  if (!name) {
    return { ok: false, error: "Server name is required." };
  }

  const resolved = resolveTransport(draft);
  if (!resolved.ok) return resolved;
  const { transport } = resolved;

  const formData: ServerFormData = {
    name,
    type: transport,
    authMethod: DEFAULT_AUTH_METHOD,
    ...(transport === "http"
      ? { url: draft.url?.trim() ?? "" }
      : { command: draft.command?.trim() ?? "", args: draft.args ?? [] }),
  };

  const validationError = validateServerFormData(formData);
  if (validationError) {
    // Relayed verbatim: it's the same message the user would see, and it
    // tells the model exactly what to fix.
    return { ok: false, error: validationError };
  }

  return { ok: true, formData };
}

/**
 * Shape a partial draft into form prefill — no completeness check.
 *
 * Returns `undefined` when there's nothing to prefill (so the command opens a
 * blank form), or a validation error only for a genuine contradiction the
 * user couldn't resolve in the form either (a bad transport, or url+command
 * together). Missing name / missing endpoint are FINE: that's what the form
 * is for.
 */
export function serverDraftToPrefill(
  draft: Partial<InspectorServerDraft> | undefined,
):
  | { ok: true; prefill: Partial<ServerFormData> | undefined }
  | { ok: false; error: string } {
  if (!draft || Object.keys(draft).length === 0) {
    return { ok: true, prefill: undefined };
  }

  const resolved = resolveTransport(draft);
  if (!resolved.ok) return resolved;
  const { transport } = resolved;

  const name = draft.name?.trim();
  const prefill: Partial<ServerFormData> = {
    type: transport,
    authMethod: DEFAULT_AUTH_METHOD,
    ...(name ? { name } : {}),
    ...(transport === "http"
      ? draft.url
        ? { url: draft.url.trim() }
        : {}
      : {
          ...(draft.command ? { command: draft.command.trim() } : {}),
          ...(draft.args ? { args: draft.args } : {}),
        }),
  };
  return { ok: true, prefill };
}
