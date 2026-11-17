/**
 * What `/api/session-token` answered. Only a body that starts with `{` is
 * parsed: a proxy's error page or another program on the port must not raise
 * a SyntaxError of its own (PLB-523, where one reached Sentry even though
 * `.catch` had handled it).
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
