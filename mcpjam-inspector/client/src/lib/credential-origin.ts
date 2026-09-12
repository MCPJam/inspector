/**
 * Will saving this edit throw away the server's stored credentials? (MJ-003)
 *
 * The backend clears a row's saved headers, env, OAuth tokens and client secret
 * when the row's DESTINATION moves — a `url` change that crosses their origin,
 * or a `command`/`args` swap on a stdio row. Either one is the same primitive:
 * anyone who can edit a project points a server somewhere they control and has
 * the Inspector deliver somebody else's credential to it.
 *
 * That is the right behaviour and a genuinely surprising one — it destroys data
 * the person saving may not have entered and cannot see. So the edit form has
 * to say so before the save, which is what this is for.
 *
 * ORIGIN, NOT URL. Editing `…/mcp` to `…/mcp/v2` keeps the credentials, and the
 * warning must not fire for it: a warning on the common harmless edit is one
 * people learn to click through, and then it is not there when it matters. The
 * stdio trigger is held to the same standard — an `args` value that was absent
 * and is now `[]` runs the same process, so it is not a change.
 *
 * These rules mirror `convex/lib/serverSecretOrigin.ts` in the backend. A copy
 * rather than an import because the renderer cannot import backend code. If the
 * rules diverge, this warns about the wrong saves — either crying wolf, or
 * staying silent while the backend wipes a credential.
 */

/**
 * The http(s) origin a credential is bound to, or `null` for anything that
 * cannot be reduced to one.
 *
 * The trailing dot is stripped because `host.example.com.` and
 * `host.example.com` are one name to a resolver and two strings to a
 * comparison. Non-http schemes are rejected rather than passed through:
 * `URL.origin` answers the opaque string `"null"` for them, which would make
 * two unrelated URLs compare equal.
 */
export function credentialOriginOf(
  url: string | null | undefined
): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return null;
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = host;
  return parsed.origin;
}

/**
 * Does this record carry at least one non-empty VALUE?
 *
 * A redacted config has the names stripped and a `has*` flag instead, so this
 * only ever answers true for the plaintext case — which is exactly the case the
 * redaction flags miss.
 */
function hasNonEmptyStringRecord(record: unknown): boolean {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }
  return Object.values(record as Record<string, unknown>).some(
    (value) => typeof value === "string" && value.length > 0
  );
}

/**
 * Does this row hold a credential a destination change would destroy?
 *
 * Read off the ROW, not off the form's `hasStored*` flags. Those mean "stored
 * AND HIDDEN from me" — `hasStoredHeaders` carries a trailing
 * `headersArray.length === 0`, so a row whose headers arrive as plaintext (the
 * local path, where nothing is redacted) reports `false` while genuinely
 * holding headers the backend will wipe. `server.has*` are the backend's own
 * answers to the question actually being asked, and the plaintext `env` /
 * `headers` records cover the rows where nothing was redacted at all.
 *
 * Plaintext `env` matters most for the stdio trigger: a local stdio row keeps
 * its environment in `config.env` in the clear, so without it the command
 * warning would never fire on exactly the rows it exists for.
 *
 * `oauthTokens` is in the list because the backend clears every
 * `hostedOAuthCredentials` row for the server on an origin change, and an
 * OAuth-connected server may hold nothing else; there is no `hasOAuthTokens`
 * redaction flag.
 */
export function rowHoldsStoredCredential(
  server:
    | {
        hasEnv?: boolean;
        hasHeaders?: boolean;
        hasBearerToken?: boolean;
        hasClientSecret?: boolean;
        oauthTokens?: unknown;
        config?: { env?: unknown; requestInit?: { headers?: unknown } };
      }
    | null
    | undefined
): boolean {
  return Boolean(
    server?.hasEnv === true ||
      server?.hasHeaders === true ||
      server?.hasBearerToken === true ||
      server?.hasClientSecret === true ||
      server?.oauthTokens != null ||
      hasNonEmptyStringRecord(server?.config?.env) ||
      hasNonEmptyStringRecord(server?.config?.requestInit?.headers)
  );
}

/** A repoint of an http row across the origin its credentials are bound to. */
export interface PendingUrlOriginClear {
  kind: "url-origin";
  previousOrigin: string;
  nextOrigin: string;
}

/**
 * A stdio row being pointed at a different process.
 *
 * The two commands are whole invocations, `command` and `args` together, so an
 * edit that changes only an argument does not render as `npx → npx`.
 */
export interface PendingStdioTargetClear {
  kind: "stdio-target";
  previousCommand: string;
  nextCommand: string;
}

export type PendingCredentialClear =
  | PendingUrlOriginClear
  | PendingStdioTargetClear;

/**
 * What the user has to have accepted for THIS destination.
 *
 * A key rather than a boolean, so acknowledging one destination and then typing
 * a different one re-arms the warning instead of carrying consent across.
 */
export function credentialClearAcknowledgementKey(
  pending: PendingCredentialClear
): string {
  return pending.kind === "url-origin"
    ? `url:${pending.nextOrigin}`
    : `stdio:${pending.nextCommand}`;
}

/**
 * The warning for a URL edit, or `null` for a save that keeps the credentials.
 *
 * Returns `null` when either URL cannot be parsed at all: the form's own
 * validation owns that, and a "your credentials will be cleared" warning on a
 * half-typed URL would fire on almost every keystroke.
 */
export function pendingCredentialClearForUrlEdit(args: {
  /** `true` when the row holds any credential a repoint would invalidate. */
  holdsStoredCredential: boolean;
  /** The URL as saved on the server row. */
  savedUrl: string | null | undefined;
  /** The URL currently in the form. */
  nextUrl: string | null | undefined;
}): PendingUrlOriginClear | null {
  if (!args.holdsStoredCredential) return null;
  const previousOrigin = credentialOriginOf(args.savedUrl);
  const nextOrigin = credentialOriginOf(args.nextUrl);
  if (previousOrigin === null || nextOrigin === null) return null;
  if (previousOrigin === nextOrigin) return null;
  return { kind: "url-origin", previousOrigin, nextOrigin };
}

/**
 * Do these two argument vectors run the same invocation?
 *
 * Absent and `[]` are the same invocation, so a row that never stored `args`
 * being written `[]` is not a change. Order matters — reordering a command's
 * arguments changes what it does — so this is an element-wise compare.
 *
 * Mirrors `sameStoredArgsValue` in the backend; the warning has to fire on
 * exactly the edits the backend clears on.
 */
function sameArgsValue(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/**
 * The warning for a stdio `command`/`args` edit, or `null` for a save that
 * keeps the credentials.
 *
 * A stdio row has no origin, so the URL rule above answers `null` for every one
 * of these — and the row's decrypted env secret is handed to whatever process
 * the `command` names. That is the same exfiltration primitive as a repoint,
 * and it is the one the form said nothing about.
 *
 * Gated on the row holding a credential, matching the backend: without that,
 * retyping the command of a server that stores no secret would warn about a
 * destruction that is not going to happen.
 *
 * Returns `null` for an empty next command for the same reason the URL rule
 * returns `null` for an unparseable URL — the form's own validation rejects it,
 * and warning mid-deletion is noise.
 */
export function pendingCredentialClearForStdioTargetEdit(args: {
  /** `true` when the row holds any credential the swap would invalidate. */
  holdsStoredCredential: boolean;
  /** The command as saved on the server row. */
  savedCommand: string | null | undefined;
  /** The arguments as saved on the server row. */
  savedArgs: readonly string[] | null | undefined;
  /** The command the form will submit. */
  nextCommand: string;
  /** The arguments the form will submit. */
  nextArgs: readonly string[];
}): PendingStdioTargetClear | null {
  if (!args.holdsStoredCredential) return null;
  const previousCommand = args.savedCommand?.trim() ?? "";
  const nextCommand = args.nextCommand.trim();
  if (!previousCommand || !nextCommand) return null;
  if (
    previousCommand === nextCommand &&
    sameArgsValue(args.savedArgs, args.nextArgs)
  ) {
    return null;
  }
  return {
    kind: "stdio-target",
    previousCommand: [previousCommand, ...(args.savedArgs ?? [])].join(" "),
    nextCommand: [nextCommand, ...args.nextArgs].join(" "),
  };
}
