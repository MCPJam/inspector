/**
 * Server-issued, verifiable tool approvals (MJ-008).
 *
 * WHY. An approval resumes in a NEW request, and everything that request says
 * about the paused turn — the tool call, its arguments, the approval request,
 * the user's answer — arrives in client-sent history. Before this module the
 * engine took all of it on the client's word: a history that CLAIMED "the
 * server asked about this call and the user said yes" ran the call, with
 * whatever arguments the history carried, on a tool the server may never have
 * asked about at all.
 *
 * THE FIX. The approval id IS the proof. When the engine pauses on a call it
 * mints the `approvalId` as an HMAC over what was actually asked:
 *
 *   (tool call id, tool name, canonical input digest, caller, project, chat)
 *
 * The id round-trips through the client unchanged — the AI SDK copies it onto
 * the UI part's `approval.id` and back onto both the `tool-approval-request`
 * and the `tool-approval-response` of the next request — so no client change
 * is needed. On resume the engine recomputes the MAC from the tool call the
 * history carries NOW. A forged request, an edited argument, a renamed tool,
 * or an id replayed into another caller's or another chat's history all fail
 * the same comparison, and a failed approval is a DENIAL, never a pass.
 *
 * WHAT IT DOES NOT PROVE. That a human clicked. Nothing a client sends can;
 * the client is the user's own software. It proves the SERVER decided this
 * exact call needed asking about, in this conversation, for this caller —
 * which is the part a forged history could previously fake.
 *
 * ONCE, AND NOT FOR LONG. A verified approval runs its call one time: the
 * engine claims it (`claimToolApprovalUse`) immediately before running the
 * call, and a claimed approval that comes back is answered, not run. Claims
 * are kept per server process, so what bounds an approval everywhere else —
 * another replica, a restarted process — is its lifetime,
 * {@link TOOL_APPROVAL_TOKEN_MAX_AGE_MS}.
 *
 * THE KEY. Derived from `INSPECTOR_SERVICE_TOKEN`, which every hosted
 * deployment already sets (it authenticates the inspector to Convex) and which
 * is identical across replicas, so a resume verifies on whichever replica it
 * lands on. The derivation label keeps the two uses apart. A non-hosted
 * process (npx, desktop, a single self-hosted container) without that token
 * uses a random per-process key: approvals then do not survive a restart,
 * which only costs a pending pill. A HOSTED process without it has no key at
 * all, and `isToolApprovalSigningAvailable()` is how the rest of the server
 * finds out — workspace operations that would ask are then left out of the
 * toolset rather than run unverified (see `built-in-tools/mcpjam.ts`).
 */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { decodeJwt } from "jose";

/** Version tag; also the prefix that marks an id as signed. */
export const TOOL_APPROVAL_TOKEN_PREFIX = "mjap1";

/**
 * How long a signed approval request stays answerable: 15 minutes.
 *
 * An approval is a person reading one prompt — the tool, its arguments — and
 * deciding. That takes seconds to a few minutes, and a quarter of an hour
 * still covers stepping away from the tab before answering. It is also the
 * longest an approval can be honoured on any server process, so it is kept
 * to what the decision needs rather than what a tab left open overnight
 * might.
 *
 * An answer that arrives later runs nothing: it is answered with
 * {@link EXPIRED_APPROVAL_RESULT}, which says so, and the model can make the
 * call again for a fresh approval.
 */
export const TOOL_APPROVAL_TOKEN_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Why an approved call did not run: the approval arrived in client-sent
 * history but the server could not verify it issued it. Model-visible, so the
 * model can ask again instead of assuming the call happened.
 */
export const UNVERIFIED_APPROVAL_RESULT =
  "Not run: this approval could not be verified as one the server issued for this exact call, so it was treated as denied.";

/**
 * The result given to a tool call that arrived in client-sent history with no
 * result and no verified approval. The server only executes calls its own
 * model step produced in THIS request, or ones a verified approval covers;
 * anything else in the history is a claim, not a request.
 */
export const UNAPPROVED_HISTORY_CALL_RESULT =
  "Not run: this tool call came from the conversation history the client sent, without an approval the server issued, so the server did not execute it.";

/**
 * Why an approved call did not run again: its approval had already been used
 * to run it once. Shown to the user and the model, so the model can ask for a
 * fresh approval instead of assuming the call happened twice.
 */
export const USED_APPROVAL_RESULT =
  "Not run again: this approval was already used to run this call once. Ask the user for a new approval to run it again.";

/**
 * Why an approved call did not run: the answer came back after the approval
 * expired. Shown to the user and the model, so neither mistakes it for a
 * denial and the model can make the call again for a fresh approval.
 */
export const EXPIRED_APPROVAL_RESULT = `Not run: this approval expired before it was used (an approval is valid for ${
  TOOL_APPROVAL_TOKEN_MAX_AGE_MS / 60_000
} minutes after it is requested), so nothing was run. If the call is still needed, make it again so the user can approve it.`;

/** Clock skew tolerated between replicas for a token minted "in the future". */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const KEY_DERIVATION_LABEL = "mcpjam/tool-approval/v1";
const MIN_SERVICE_TOKEN_LENGTH = 16;

/** Who and where an approval was asked. All three must match on resume. */
export interface ToolApprovalBinding {
  subject: string;
  projectId: string;
  chatSessionId: string;
}

/** What was asked about. */
export interface ToolApprovalCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export type ToolApprovalVerification =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "no_key"
        | "unsigned"
        | "malformed"
        | "signature_mismatch"
        | "expired";
    };

/**
 * Marks a built tool whose approval must be VERIFIED server-side, with no
 * legacy fallback. A registered symbol, so it survives the `{...tool}` spreads
 * of every ToolSet wrapper yet never reaches a serialized tool definition.
 */
const SERVER_VERIFIED_APPROVAL = Symbol.for("mcpjam.serverVerifiedApproval");

export function markServerVerifiedApproval<T extends object>(tool: T): T {
  (tool as unknown as Record<symbol, unknown>)[SERVER_VERIFIED_APPROVAL] = true;
  return tool;
}

export function requiresServerVerifiedApproval(tool: unknown): boolean {
  return (
    !!tool &&
    typeof tool === "object" &&
    (tool as Record<symbol, unknown>)[SERVER_VERIFIED_APPROVAL] === true
  );
}

let ephemeralKey: Buffer | undefined;

/**
 * A key derived from `INSPECTOR_SERVICE_TOKEN` for one purpose, named by
 * `label`, or null when the token is missing or too short to be a secret.
 * Distinct labels give independent keys, so no two uses can stand in for
 * each other, and the token itself is never used as a key.
 */
export function deriveServiceTokenKey(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  const serviceToken = env.INSPECTOR_SERVICE_TOKEN?.trim();
  if (!serviceToken || serviceToken.length < MIN_SERVICE_TOKEN_LENGTH) {
    return null;
  }
  return createHmac("sha256", serviceToken).update(label).digest();
}

/**
 * The HMAC key, or null when this deployment cannot issue verifiable
 * approvals. Parameters exist for tests; production reads the process env.
 */
export function resolveToolApprovalSigningKey(
  env: NodeJS.ProcessEnv = process.env,
  hosted: boolean = process.env.VITE_MCPJAM_HOSTED_MODE === "true",
): Buffer | null {
  const derived = deriveServiceTokenKey(KEY_DERIVATION_LABEL, env);
  if (derived) return derived;
  if (!hosted) {
    ephemeralKey ??= randomBytes(32);
    return ephemeralKey;
  }
  return null;
}

export function isToolApprovalSigningAvailable(): boolean {
  return resolveToolApprovalSigningKey() !== null;
}

/**
 * Deterministic JSON: object keys sorted at every depth, `undefined` members
 * dropped (JSON never carries them, so a round-tripped copy cannot either).
 * The input a client echoes back went through `JSON.stringify`/`parse`; this
 * makes key order the one difference that can never matter.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** sha256 of the canonical form, or null for a value JSON cannot encode. */
export function canonicalDigest(value: unknown): string | null {
  try {
    return createHash("sha256")
      .update(canonicalJson(value))
      .digest("base64url");
  } catch {
    return null;
  }
}

/**
 * The stable identity an approval binds to, read from the request's bearer.
 *
 * A JWT is bound by its `iss` + `sub` — stable across refreshes, so an
 * approval answered after the browser refreshed its token still verifies. The
 * claim is read WITHOUT verifying the signature, and that is sufficient here:
 * every tool the approval can unlock executes with that same bearer, which
 * Convex verifies, so claiming someone else's subject buys a verified
 * approval for a call that will then be refused. Anything that is not a JWT
 * (an API key) binds by its hash, never its value.
 */
export function toolApprovalSubjectFromAuthHeader(
  authHeader: string | null | undefined,
): string {
  const raw = authHeader?.trim() ?? "";
  const token = raw.replace(/^bearer(?:\s+|$)/i, "").trim();
  if (!token) return "anonymous";
  if (token.split(".").length === 3) {
    try {
      const claims = decodeJwt(token);
      if (typeof claims.sub === "string" && claims.sub.length > 0) {
        return `sub:${typeof claims.iss === "string" ? claims.iss : ""}:${
          claims.sub
        }`;
      }
    } catch {
      // Not a decodable JWT — bind by hash below.
    }
  }
  return `bearer:${createHash("sha256").update(token).digest("base64url")}`;
}

export function toolApprovalBindingFor(args: {
  authHeader?: string | null;
  projectId?: string | null;
  chatSessionId?: string | null;
}): ToolApprovalBinding {
  return {
    subject: toolApprovalSubjectFromAuthHeader(args.authHeader),
    projectId: args.projectId ?? "",
    chatSessionId: args.chatSessionId ?? "",
  };
}

function macFor(
  key: Buffer,
  issuedAt: string,
  nonce: string,
  call: ToolApprovalCall,
  inputDigest: string,
  binding: ToolApprovalBinding,
): Buffer {
  return createHmac("sha256", key)
    .update(
      JSON.stringify([
        TOOL_APPROVAL_TOKEN_PREFIX,
        issuedAt,
        nonce,
        call.toolCallId,
        call.toolName,
        inputDigest,
        binding.subject,
        binding.projectId,
        binding.chatSessionId,
      ]),
    )
    .digest();
}

/**
 * Mint the approval id for a call the server is about to ask about.
 *
 * Returns null when no key is available or the input cannot be canonicalized;
 * the caller decides what an unsignable approval means for its tool.
 */
export function mintToolApprovalId(args: {
  call: ToolApprovalCall;
  binding: ToolApprovalBinding;
  key?: Buffer | null;
  nowMs?: number;
}): string | null {
  const key =
    args.key === undefined ? resolveToolApprovalSigningKey() : args.key;
  if (!key) return null;
  const inputDigest = canonicalDigest(args.call.input ?? {});
  if (!inputDigest) return null;
  const issuedAt = Math.floor((args.nowMs ?? Date.now()) / 1000).toString(36);
  const nonce = randomBytes(12).toString("base64url");
  const mac = macFor(
    key,
    issuedAt,
    nonce,
    args.call,
    inputDigest,
    args.binding,
  ).toString("base64url");
  return `${TOOL_APPROVAL_TOKEN_PREFIX}.${issuedAt}.${nonce}.${mac}`;
}

/** Whether an id has the SHAPE of a signed approval (says nothing about validity). */
export function isSignedToolApprovalId(approvalId: string): boolean {
  return approvalId.startsWith(`${TOOL_APPROVAL_TOKEN_PREFIX}.`);
}

/**
 * Verify that `approvalId` is an approval this server issued for exactly this
 * call, caller and conversation. Never throws.
 */
export function verifyToolApprovalId(args: {
  approvalId: string;
  call: ToolApprovalCall;
  binding: ToolApprovalBinding;
  key?: Buffer | null;
  nowMs?: number;
}): ToolApprovalVerification {
  const key =
    args.key === undefined ? resolveToolApprovalSigningKey() : args.key;
  if (!key) return { ok: false, reason: "no_key" };
  if (
    typeof args.approvalId !== "string" ||
    !isSignedToolApprovalId(args.approvalId)
  ) {
    return { ok: false, reason: "unsigned" };
  }
  const parts = args.approvalId.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [, issuedAt, nonce, mac] = parts;
  if (!issuedAt || !nonce || !mac || !/^[0-9a-z]+$/.test(issuedAt)) {
    return { ok: false, reason: "malformed" };
  }
  const issuedAtMs = parseInt(issuedAt, 36) * 1000;
  const nowMs = args.nowMs ?? Date.now();
  if (!Number.isFinite(issuedAtMs) || issuedAtMs > nowMs + MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: "malformed" };
  }
  const inputDigest = canonicalDigest(args.call.input ?? {});
  if (!inputDigest) return { ok: false, reason: "malformed" };
  let given: Buffer;
  try {
    given = Buffer.from(mac, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const expected = macFor(
    key,
    issuedAt,
    nonce,
    args.call,
    inputDigest,
    args.binding,
  );
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  // Checked AFTER the MAC so an expired-but-forged id reports as forged.
  if (nowMs - issuedAtMs > TOOL_APPROVAL_TOKEN_MAX_AGE_MS) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

/**
 * Approvals that have already run their call, on this process (MJ-008).
 *
 * A verified approval proves the server asked about exactly this call; it
 * should also run that call exactly once. Keyed by the approval id, which is
 * unique per issue (it carries a random nonce), and kept until the id could no
 * longer verify anyway. Insertion order is expiry order, so pruning only ever
 * looks at the front, and the map is bounded: past the cap the oldest entries
 * go first.
 *
 * SCOPE: one server process. Single use holds within the process that ran the
 * call; across processes — other replicas, or this one after a restart — an
 * approval's use is bounded by its lifetime,
 * {@link TOOL_APPROVAL_TOKEN_MAX_AGE_MS}, after which no process honours it.
 */
const usedApprovalExpiry = new Map<string, number>();
const MAX_USED_APPROVALS = 50_000;

/**
 * Record that `approvalId` is about to run its call. Returns false when it
 * already has, in which case the caller must not run it again. Call it only
 * for an approval that verified, immediately before running the call.
 */
export function claimToolApprovalUse(
  approvalId: string,
  nowMs: number = Date.now(),
): boolean {
  for (const [id, expiresAt] of usedApprovalExpiry) {
    if (expiresAt > nowMs) break;
    usedApprovalExpiry.delete(id);
  }
  if (usedApprovalExpiry.has(approvalId)) return false;
  usedApprovalExpiry.set(
    approvalId,
    nowMs + TOOL_APPROVAL_TOKEN_MAX_AGE_MS + MAX_FUTURE_SKEW_MS,
  );
  while (usedApprovalExpiry.size > MAX_USED_APPROVALS) {
    const oldest = usedApprovalExpiry.keys().next().value;
    if (oldest === undefined) break;
    usedApprovalExpiry.delete(oldest);
  }
  return true;
}
