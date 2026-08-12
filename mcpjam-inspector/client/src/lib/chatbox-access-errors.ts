/**
 * Classification of the two chatbox access failures a turn can hit, and the
 * one body edit recovering from them requires.
 *
 * A chatbox turn re-resolves its authoritative config on the server every
 * time, so an open tab can lose access between one send and the next: a
 * rebind moves the environment, a mode round-trip deactivates link grants,
 * a guest identity rotates. Those refusals arrive as ordinary non-ok
 * responses, and until they carry a code the client cannot tell them from a
 * genuine server fault — which is why the recovery layer needs a classifier
 * rather than a message-substring test.
 */

export type ChatboxAccessErrorKind = "stale" | "denied";

export interface ChatboxAccessErrorInfo {
  kind: ChatboxAccessErrorKind;
  status: number;
  code?: string;
  message: string;
}

interface RouteErrorBodyShape {
  code?: unknown;
  message?: unknown;
  error?: unknown;
  details?: { code?: unknown } | null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Mirrors `readRouteError`'s precedence (ChatboxChatPage.tsx): the DOMAIN
 * code in `details.code` wins over the transport-level top-level `code`,
 * because the domain code says WHY.
 */
function readCode(body: RouteErrorBodyShape): string | undefined {
  return readString(body.details?.code) ?? readString(body.code);
}

function readMessage(body: RouteErrorBodyShape, status: number): string {
  return (
    readString(body.message) ??
    readString(body.error) ??
    `Request failed with status ${status}`
  );
}

/**
 * Returns null for anything that isn't a chatbox access verdict — including
 * bare 403s, which on this wire are frequently an OAuth `insufficient_scope`
 * challenge and must NOT be routed into a re-redeem.
 */
export function classifyChatboxAccessError(
  status: number,
  body: unknown
): ChatboxAccessErrorInfo | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const shaped = body as RouteErrorBodyShape;
  const code = readCode(shaped);
  const message = readMessage(shaped, status);

  if (code === "CHATBOX_ACCESS_STALE") {
    return { kind: "stale", status, code, message };
  }
  if (code === "CHATBOX_ACCESS_DENIED") {
    return { kind: "denied", status, code, message };
  }

  // TODO(chatbox-access-codes): remove once every deployed server emits
  // CHATBOX_ACCESS_DENIED. Kept narrow ON PURPOSE — it matches only the
  // fail-closed branch's own authored prefix, never a bare 403.
  if (
    status === 403 &&
    code === "INTERNAL_ERROR" &&
    message.startsWith("Couldn't load this chatbox's settings")
  ) {
    return { kind: "denied", status, code, message };
  }

  return null;
}

/**
 * Clone-based so the caller keeps an unconsumed `response` to return or hand
 * to the stream parser when the body turns out not to be an access verdict.
 */
export async function classifyChatboxAccessResponse(
  response: Response
): Promise<ChatboxAccessErrorInfo | null> {
  try {
    const body = await response.clone().json();
    return classifyChatboxAccessError(response.status, body);
  } catch {
    return null;
  }
}

/**
 * Stamps a freshly redeemed `accessVersion` into an already-serialized
 * request body so the replayed turn is byte-identical except for the field
 * that went stale. Returns the input untouched if it isn't a JSON object —
 * a replay with the old version is still better than no replay.
 */
export function patchBodyAccessVersion(
  bodyJson: string,
  accessVersion: number
): string {
  try {
    const parsed = JSON.parse(bodyJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return bodyJson;
    }
    return JSON.stringify({ ...parsed, accessVersion });
  } catch {
    return bodyJson;
  }
}
