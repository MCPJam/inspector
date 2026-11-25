/**
 * What `/api/session-token` answered. Only a body that starts with `{` is
 * parsed, so a proxy's error page or another program on the port never creates
 * a SyntaxError.
 */
export interface AccessAnswer {
  ok: boolean;
  code?: string;
  /** Media type without parameters, such as `text/html`. */
  contentType?: string;
}

export async function readAccessAnswer(
  response: Response,
): Promise<AccessAnswer> {
  const contentType =
    response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ||
    undefined;
  const text = await response.text().catch(() => "");
  const body = text.trimStart().startsWith("{") ? parseObject(text) : null;
  if (!body) return { ok: false, contentType };
  return {
    ok: "ok" in body && body.ok === true,
    code:
      "code" in body && typeof body.code === "string" ? body.code : undefined,
    contentType,
  };
}

function parseObject(text: string): object | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Error thrown when `/api/session-token` does not confirm the access link: a
 * non-OK status, or a 2xx whose body is not `{ ok: true }` for a valid token.
 * It carries the HTTP status and code so the bootstrap can tell the Inspector's
 * EXPECTED answers (403 `HOST_NOT_ALLOWED`, 401 `ACCESS_LINK_REQUIRED`) apart
 * from a genuine failure, and the content type for the report.
 *
 * A 403 here is not a bug: the server withholds the token from any host that
 * isn't localhost or in `MCPJAM_ALLOWED_HOSTS` (see server/utils/localhost-check.ts).
 * A self-hosted user reaching the inspector over the network hits exactly this,
 * and it has a self-service fix (allowlist their host) — so it gets a tailored
 * screen and is NOT reported to Sentry, unlike a real 5xx/transport failure.
 */
export class SessionTokenError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly restarted: boolean;
  readonly contentType?: string;
  constructor(
    status: number,
    {
      code,
      restarted = false,
      contentType,
    }: { code?: string; restarted?: boolean; contentType?: string } = {},
  ) {
    super(`Failed to get session token: ${status}`);
    this.name = "SessionTokenError";
    this.status = status;
    this.code = code;
    this.restarted = restarted;
    this.contentType = contentType;
  }
}

/**
 * Whether `error` is the Inspector's expected "host not allowed" denial: a 403
 * carrying `HOST_NOT_ALLOWED`. These are self-inflicted-by-config, not defects:
 * the caller renders guidance instead of a generic error and skips error
 * reporting. A 403 page from anything else is a genuine failure.
 */
export function isSessionTokenHostDenied(error: unknown): boolean {
  return (
    error instanceof SessionTokenError &&
    error.status === 403 &&
    error.code === "HOST_NOT_ALLOWED"
  );
}

/**
 * Whether `error` is the Inspector asking for the access link: a 401 carrying
 * `ACCESS_LINK_REQUIRED`. The same code under another status did not come from
 * the Inspector's route, so it is reported instead.
 */
export function isAccessLinkRequired(
  error: unknown,
): error is SessionTokenError {
  return (
    error instanceof SessionTokenError &&
    error.status === 401 &&
    error.code === "ACCESS_LINK_REQUIRED"
  );
}
