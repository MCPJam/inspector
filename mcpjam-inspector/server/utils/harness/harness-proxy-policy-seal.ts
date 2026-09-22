/**
 * Harness MCP proxy POLICY SEAL — the credential that carries its own policy.
 *
 * D4 enforces `toolPolicy` in-process, inside the AI SDK tool loop. A harness
 * run has no such loop: the real runtime calls MCP itself from a disposable
 * sandbox using the generated `.mcp.json`. Every entry there points at MCPJam's
 * own proxy (`/api/web/harness-mcp/:serverId`), so the proxy is the chokepoint —
 * but the policy has to REACH it without shared state (that route is stateless
 * and horizontally scaled) and without being droppable.
 *
 * THREAT MODEL: the adversary is a capable agent that is not attacking us — an
 * LLM with `bash` in its own sandbox that may "repair" a failing MCP connection
 * by editing `.mcp.json`. The rule that follows is **removing the policy must
 * remove access**, which rules out a second policy header, a signed policy in
 * the URL, and a signed-but-cleartext envelope (extract the inner token, send it
 * bare). So the policy is not attached to the credential: it ENCLOSES it. The
 * sandbox holds one opaque blob; stripping the policy strips the credential.
 *
 * Identity authority is untouched: the plaintext carries the Convex-minted
 * token verbatim and the route still verifies it through the unchanged
 * `verifyHarnessProxyToken`. This module only adds inspector-signed policy
 * around it (the policy comes from the suite file / run request the inspector
 * holds, so Convex signing it would add a mirrored claim contract and no
 * authority).
 *
 * AES-256-GCM with an HKDF-derived key over the SAME
 * `COMPUTERS_TERMINAL_TOKEN_SECRET` the token verifier already requires — no new
 * deployment secret, purpose-isolated by the HKDF `info` string exactly as the
 * token's `purpose` claim isolates it from terminal tokens.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  isToolPolicyDecisionReason,
  type ToolPolicySnapshot,
} from "@mcpjam/sdk/contract";

/** Versioned prefix: an envelope shape change must be a new prefix, never a
 *  reinterpretation of these bytes. */
export const HARNESS_PROXY_POLICY_SEAL_PREFIX = "mcpjps1";
const HKDF_INFO = "harness-mcp-proxy-policy-seal.v1";
const HKDF_SALT = "mcpjam-harness-mcp-proxy-policy-seal";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const MIN_SECRET_LENGTH = 16;
/** Bound the sealed plaintext. Over cap the RUN is refused at launch — never
 *  truncated: truncating a deny list silently permits the calls it dropped. */
export const MAX_SEALED_PLAINTEXT_BYTES = 8 * 1024;
/** Bound the denied-name count for the same reason. */
export const MAX_SEALED_DENIED_TOOL_NAMES = 500;

/** The sealed plaintext. Short keys because it rides an HTTP header. */
interface SealedPolicyEnvelope {
  v: 1;
  /** The Convex-minted proxy token, verbatim. */
  t: string;
  /** The serverId this envelope was sealed for. */
  s: string;
  /** Envelope expiry, unix SECONDS (independent of the inner token's own). */
  exp: number;
  /** Resolved decision snapshot — a lookup table, not a policy to re-evaluate. */
  p: ToolPolicySnapshot;
}

export interface SealedHarnessProxyPolicy {
  token: string;
  serverId: string;
  policy: ToolPolicySnapshot;
}

export class HarnessProxyPolicySealTooLargeError extends Error {
  readonly code = "TOOL_POLICY_TOO_LARGE";
}

function deriveKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", secret, HKDF_SALT, HKDF_INFO, KEY_LENGTH)
  );
}

function readSecret(): string {
  const secret = process.env.COMPUTERS_TERMINAL_TOKEN_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "harness-proxy-policy-seal: COMPUTERS_TERMINAL_TOKEN_SECRET is not set on this deployment"
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `harness-proxy-policy-seal: COMPUTERS_TERMINAL_TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters`
    );
  }
  return secret;
}

/**
 * Can this deployment seal at all? Callers use this to REFUSE a policied
 * harness run at launch rather than start one that would run unpoliced.
 */
export function isHarnessProxyPolicySealAvailable(): boolean {
  try {
    readSecret();
    return true;
  } catch {
    return false;
  }
}

/** Does this value look like a sealed envelope (as opposed to a bare token)? */
export function isSealedHarnessProxyToken(value: string | undefined): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(`${HARNESS_PROXY_POLICY_SEAL_PREFIX}.`)
  );
}

/**
 * Seal `{ token, serverId, policy }` into the opaque `X-MCPJam-Proxy-Token`
 * value. THROWS when the deployment cannot seal (missing/weak secret) or the
 * envelope exceeds its bounds — a policied run must fail closed, not degrade to
 * a bare token.
 */
export function sealHarnessProxyToken(args: {
  token: string;
  serverId: string;
  policy: ToolPolicySnapshot;
  expiresAtMs: number;
}): string {
  const secret = readSecret();
  const deniedCount = Object.keys(args.policy.denied).length;
  if (deniedCount > MAX_SEALED_DENIED_TOOL_NAMES) {
    throw new HarnessProxyPolicySealTooLargeError(
      `TOOL_POLICY_TOO_LARGE: tool policy resolves to ${deniedCount} denied tools for server ${args.serverId}, above the ${MAX_SEALED_DENIED_TOOL_NAMES} the harness proxy envelope carries`
    );
  }
  const envelope: SealedPolicyEnvelope = {
    v: 1,
    t: args.token,
    s: args.serverId,
    exp: Math.floor(args.expiresAtMs / 1000),
    p: args.policy,
  };
  const plaintext = Buffer.from(JSON.stringify(envelope), "utf8");
  if (plaintext.byteLength > MAX_SEALED_PLAINTEXT_BYTES) {
    throw new HarnessProxyPolicySealTooLargeError(
      `TOOL_POLICY_TOO_LARGE: sealed harness policy envelope for server ${args.serverId} is ${plaintext.byteLength} bytes, above the ${MAX_SEALED_PLAINTEXT_BYTES}-byte cap`
    );
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const sealed = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return [
    HARNESS_PROXY_POLICY_SEAL_PREFIX,
    iv.toString("base64url"),
    sealed.toString("base64url"),
  ].join(".");
}

/**
 * Open a sealed envelope. Returns `null` for ANY verification-side failure
 * (missing/weak secret, wrong prefix, malformed parts, tampered bytes, wrong
 * version, wrong serverId, expired) — never throws, mirroring
 * `verifyHarnessProxyToken`. The caller still has to verify the inner token.
 */
export function unsealHarnessProxyToken(
  value: string | undefined | null,
  serverId: string,
  opts: { nowMs?: number } = {}
): SealedHarnessProxyPolicy | null {
  if (!value || !isSealedHarnessProxyToken(value)) return null;
  let secret: string;
  try {
    secret = readSecret();
  } catch {
    return null;
  }
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [, ivPart, sealedPart] = parts;
  if (!ivPart || !sealedPart) return null;

  let plaintext: Buffer;
  try {
    const iv = Buffer.from(ivPart, "base64url");
    const sealed = Buffer.from(sealedPart, "base64url");
    if (iv.byteLength !== IV_LENGTH || sealed.byteLength <= 16) return null;
    const ciphertext = sealed.subarray(0, sealed.byteLength - 16);
    const tag = sealed.subarray(sealed.byteLength - 16);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // A tampered byte fails the GCM tag here. Fail closed, silently.
    return null;
  }
  if (plaintext.byteLength > MAX_SEALED_PLAINTEXT_BYTES) return null;

  let envelope: SealedPolicyEnvelope;
  try {
    envelope = JSON.parse(plaintext.toString("utf8"));
  } catch {
    return null;
  }
  if (envelope?.v !== 1) return null;
  if (typeof envelope.t !== "string" || envelope.t.length === 0) return null;
  if (typeof envelope.s !== "string" || envelope.s !== serverId) return null;
  if (typeof envelope.exp !== "number") return null;
  // Same NumericDate semantics as the inner token: expired AT `exp`.
  if (Math.floor((opts.nowMs ?? Date.now()) / 1000) >= envelope.exp) {
    return null;
  }
  const policy = envelope.p;
  if (!policy || typeof policy !== "object") return null;
  if (policy.mode !== "default" && policy.mode !== "readOnly") return null;
  if (policy.unknownTool !== "deny" && policy.unknownTool !== "allow") {
    return null;
  }
  if (!policy.denied || typeof policy.denied !== "object") return null;
  if (Object.keys(policy.denied).length > MAX_SEALED_DENIED_TOOL_NAMES) {
    return null;
  }
  // Validate the WHOLE snapshot, not the fields the happy path reads first: the
  // route hands this straight to `decideToolPolicyFromSnapshot`, which does a
  // `known.includes(...)` and reads each denied entry's reason. A snapshot that
  // parsed but is shaped wrong would throw there — inside the request the
  // policy is meant to guard — and a 500 on `tools/call` is a worse outcome
  // than refusing this credential.
  if (!Array.isArray(policy.known)) return null;
  if (policy.known.some((name) => typeof name !== "string")) return null;
  for (const entry of Object.values(policy.denied)) {
    if (!entry || typeof entry !== "object") return null;
    if (!isToolPolicyDecisionReason(entry.reason)) return null;
    if (typeof entry.classification !== "string") return null;
  }

  return { token: envelope.t, serverId: envelope.s, policy };
}
