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
 * AES-256-GCM with an HKDF-derived key, purpose-isolated by the HKDF `info`
 * string. The secret it is derived from follows the enclosed credential's
 * algorithm, so a lane's sealed handle keeps its bytes for the lane's life:
 * an HS256 credential is sealed under `COMPUTERS_TERMINAL_TOKEN_SECRET`, as
 * every envelope was before, and an RS256 one under `HARNESS_PROXY_SEAL_SECRET`,
 * which the web and worker services must share. The old secret seals and opens
 * nothing once `HARNESS_PROXY_ACCEPT_HS256=false`.
 */
import { MAX_SEALED_PLAINTEXT_BYTES } from "./harness-proxy-limits.js";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  isToolPolicyDecisionReason,
  type ToolPolicySnapshot,
} from "@mcpjam/sdk/contract";
import {
  harnessConnectionProfileSchema,
  type HarnessConnectionProfile,
} from "./harness-connection-profile.js";
import {
  acceptsHs256HarnessCredentials,
  harnessCredentialAlg,
} from "./harness-proxy-token.js";

/** Versioned prefix: an envelope shape change must be a new prefix, never a
 *  reinterpretation of these bytes. */
export const HARNESS_PROXY_POLICY_SEAL_PREFIX = "mcpjps1";
const HKDF_INFO = "harness-mcp-proxy-policy-seal.v1";
const HKDF_SALT = "mcpjam-harness-mcp-proxy-policy-seal";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const MIN_SECRET_LENGTH = 16;
const MIN_SEAL_SECRET_LENGTH = 32;
/** Bound the sealed plaintext. Over cap the RUN is refused at launch — never
 *  truncated: truncating a deny list silently permits the calls it dropped. */
export { MAX_SEALED_PLAINTEXT_BYTES } from "./harness-proxy-limits.js";
/** Bound the denied-name count for the same reason. */
export const MAX_SEALED_DENIED_TOOL_NAMES = 500;

/** The sealed plaintext. Short keys because it rides an HTTP header. */
export type HarnessProxyTurn = { laneId: string; leaseId: string };

interface SealedPolicyEnvelope {
  /** 4 is a session envelope: deterministic, no expiry, `t` is a session
   *  handle. 5 is one whose server is bridged with its profile: a separate
   *  version, so an instance that predates it refuses the envelope rather
   *  than forwarding the runtime's own bytes past the profile. 6 is a session
   *  envelope that names the runtime's correlation key (`ck`), bridged when
   *  `d` says so: an instance that predates it would neither strip that key
   *  nor bind the call to its approval, so it refuses the envelope. */
  v: 1 | 2 | 3 | 4 | 5 | 6;
  ck?: string;
  d?: "bridge";
  turn?: HarnessProxyTurn;
  profile?: HarnessConnectionProfile;
  /** `profile.versionNegotiation`, kept out of `profile`: an instance that
   *  predates it validates `profile` strictly and ignores keys here, so a
   *  mixed fleet keeps opening envelopes. */
  vn?: "legacy-first";
  /** The Convex-minted proxy token, verbatim. */
  t: string;
  /** The serverId this envelope was sealed for. */
  s: string;
  /** Envelope expiry, unix SECONDS (independent of the inner token's own). */
  exp?: number;
  /** Resolved decision snapshot — a lookup table, not a policy to re-evaluate. */
  p: ToolPolicySnapshot;
}

export interface SealedHarnessProxyPolicy {
  turn?: HarnessProxyTurn;
  /** The inner token is a lane's session handle, not a per-turn token. */
  session?: true;
  /** MCPJam's client stands in for the runtime's, with `profile`. */
  delivery?: "bridge";
  /** Where the runtime stamps a call's id on a session envelope's requests. */
  correlationKey?: string;
  token: string;
  serverId: string;
  policy: ToolPolicySnapshot;
  profile?: HarnessConnectionProfile;
}

export class HarnessProxyPolicySealTooLargeError extends Error {
  readonly code = "TOOL_POLICY_TOO_LARGE";
}

function deriveKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", secret, HKDF_SALT, HKDF_INFO, KEY_LENGTH)
  );
}

/** A key of its own for the session envelope's synthetic IV. */
function deriveIvKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", secret, HKDF_SALT, `${HKDF_INFO}.session-iv`, KEY_LENGTH)
  );
}

/** `HARNESS_PROXY_SEAL_SECRET`, or null when unset or too short. */
function sealSecret(): string | null {
  const secret = process.env.HARNESS_PROXY_SEAL_SECRET?.trim();
  return secret && secret.length >= MIN_SEAL_SECRET_LENGTH ? secret : null;
}

/**
 * `COMPUTERS_TERMINAL_TOKEN_SECRET`, while HS256 credentials are accepted:
 * what every envelope was sealed under before the seal secret existed.
 */
function legacySecret(): string | null {
  const secret = process.env.COMPUTERS_TERMINAL_TOKEN_SECRET?.trim();
  return secret &&
    secret.length >= MIN_SECRET_LENGTH &&
    acceptsHs256HarnessCredentials()
    ? secret
    : null;
}

/**
 * The secret an envelope enclosing `token` is sealed under, or null when it
 * is missing. An HS256 credential keeps the old derivation and an RS256 one
 * takes the seal secret, so a lane's envelope never changes under it.
 * Anything else (a forwarding context) takes whichever is present.
 */
function expectedSecret(token: string): string | null {
  const alg = harnessCredentialAlg(token);
  if (alg === "HS256") return legacySecret();
  if (alg === "RS256") return sealSecret();
  return sealSecret() ?? legacySecret();
}

/** {@link expectedSecret}, THROWING when it is missing: sealing fails closed. */
function secretFor(token: string): string {
  const alg = harnessCredentialAlg(token);
  const secret = expectedSecret(token);
  if (!secret) {
    const seal = `HARNESS_PROXY_SEAL_SECRET must be set, at least ${MIN_SEAL_SECRET_LENGTH} characters`;
    const legacy = `COMPUTERS_TERMINAL_TOKEN_SECRET must be set, at least ${MIN_SECRET_LENGTH} characters, while HS256 harness credentials are accepted`;
    throw new Error(
      `harness-proxy-policy-seal: ${
        alg === "HS256"
          ? legacy
          : alg === "RS256"
            ? seal
            : `${seal}, or ${legacy}`
      }`,
    );
  }
  return secret;
}

/**
 * Can this deployment seal at all? Callers use this to REFUSE a policied
 * harness run at launch rather than start one that would run unpoliced. The
 * old secret still counts while the backend mints HS256 credentials.
 */
export function isHarnessProxyPolicySealAvailable(): boolean {
  return Boolean(sealSecret() ?? legacySecret());
}

/** Does this value look like a sealed envelope (as opposed to a bare token)? */
export function isSealedHarnessProxyToken(value: string | undefined): boolean {
  return (
    typeof value === "string" &&
    (value.startsWith(`${HARNESS_PROXY_POLICY_SEAL_PREFIX}.`) ||
      value.startsWith("mcpjps2.") || value.startsWith("mcpjps3.") ||
      value.startsWith("mcpjps4.") || value.startsWith("mcpjps5.") ||
      value.startsWith("mcpjps6."))
  );
}

/**
 * Seal `{ token, serverId, policy }` into the opaque `X-MCPJam-Proxy-Token`
 * value. THROWS when the deployment cannot seal (missing/weak secret) or the
 * envelope exceeds its bounds — a policied run must fail closed, not degrade to
 * a bare token.
 */
export function sealHarnessProxyToken(args: {
  turn?: HarnessProxyTurn;
  token: string;
  serverId: string;
  policy: ToolPolicySnapshot;
  expiresAtMs: number;
  profile?: HarnessConnectionProfile;
}): string {
  const secret = secretFor(args.token);
  const deniedCount = Object.keys(args.policy.denied).length;
  if (deniedCount > MAX_SEALED_DENIED_TOOL_NAMES) {
    throw new HarnessProxyPolicySealTooLargeError(
      `TOOL_POLICY_TOO_LARGE: tool policy resolves to ${deniedCount} denied tools for server ${args.serverId}, above the ${MAX_SEALED_DENIED_TOOL_NAMES} the harness proxy envelope carries`,
    );
  }
  const envelope: SealedPolicyEnvelope = {
    v: args.turn ? 3 : args.profile ? 2 : 1,
    ...(args.turn ? { turn: args.turn } : {}),
    ...sealedProfile(args.profile),
    t: args.token,
    s: args.serverId,
    exp: Math.floor(args.expiresAtMs / 1000),
    p: args.policy,
  };
  return encryptEnvelope(secret, envelope, randomBytes(IV_LENGTH));
}

function sealedProfile(
  input: HarnessConnectionProfile | undefined,
): Pick<SealedPolicyEnvelope, "profile" | "vn"> {
  if (!input) return {};
  const { versionNegotiation, ...profile } =
    harnessConnectionProfileSchema.parse(input);
  return { profile, ...(versionNegotiation ? { vn: versionNegotiation } : {}) };
}

function encryptEnvelope(
  secret: string,
  envelope: SealedPolicyEnvelope,
  ivFor: Buffer | ((plaintext: Buffer) => Buffer),
): string {
  const plaintext = Buffer.from(JSON.stringify(envelope), "utf8");
  if (plaintext.byteLength > MAX_SEALED_PLAINTEXT_BYTES) {
    throw new HarnessProxyPolicySealTooLargeError(
      `TOOL_POLICY_TOO_LARGE: sealed harness policy envelope for server ${envelope.s} is ${plaintext.byteLength} bytes, above the ${MAX_SEALED_PLAINTEXT_BYTES}-byte cap`,
    );
  }
  const iv = typeof ivFor === "function" ? ivFor(plaintext) : ivFor;
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const sealed = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return [
    `mcpjps${envelope.v}`,
    iv.toString("base64url"),
    sealed.toString("base64url"),
  ].join(".");
}

/**
 * Seal a lane's session handle with the server's policy and profile.
 *
 * Deterministic: the IV is derived from the plaintext with a separate key, so
 * the same handle, policy and profile always give the same envelope. A runtime
 * that fingerprints its MCP configuration (Cursor's ACP adapter compares header
 * values on every resume) then sees one value for the whole session. Equal
 * envelopes reveal only that their plaintexts are equal. No expiry: the route
 * checks the lane's live turn on every request instead.
 */
export function sealHarnessSessionEnvelope(args: {
  handle: string;
  serverId: string;
  policy: ToolPolicySnapshot;
  profile?: HarnessConnectionProfile;
  /** Bridged with `profile`; a bridge without one is never sealed. */
  delivery?: "bridge";
  /** The runtime's correlation key, for a runtime that stamps one. */
  correlationKey?: string;
}): string {
  const secret = secretFor(args.handle);
  const deniedCount = Object.keys(args.policy.denied).length;
  if (deniedCount > MAX_SEALED_DENIED_TOOL_NAMES) {
    throw new HarnessProxyPolicySealTooLargeError(
      `TOOL_POLICY_TOO_LARGE: tool policy resolves to ${deniedCount} denied tools for server ${args.serverId}, above the ${MAX_SEALED_DENIED_TOOL_NAMES} the harness proxy envelope carries`,
    );
  }
  if (args.delivery === "bridge" && !args.profile)
    throw new Error("A bridged session envelope needs its connection profile.");
  const envelope: SealedPolicyEnvelope = {
    ...(args.correlationKey
      ? {
          v: 6 as const,
          ck: args.correlationKey,
          ...(args.delivery === "bridge" ? { d: "bridge" as const } : {}),
        }
      : { v: args.delivery === "bridge" ? (5 as const) : (4 as const) }),
    ...sealedProfile(args.profile),
    t: args.handle,
    s: args.serverId,
    p: args.policy,
  };
  return encryptEnvelope(secret, envelope, (plaintext) =>
    createHmac("sha256", deriveIvKey(secret))
      .update(plaintext)
      .digest()
      .subarray(0, IV_LENGTH),
  );
}

/** The envelope's plaintext under `secret`, or null when the tag refuses it. */
function decryptEnvelope(
  secret: string,
  ivPart: string,
  sealedPart: string,
): Buffer | null {
  try {
    const iv = Buffer.from(ivPart, "base64url");
    const sealed = Buffer.from(sealedPart, "base64url");
    if (iv.byteLength !== IV_LENGTH || sealed.byteLength <= 16) return null;
    const ciphertext = sealed.subarray(0, sealed.byteLength - 16);
    const tag = sealed.subarray(sealed.byteLength - 16);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // A tampered byte, or another secret, fails the GCM tag here.
    return null;
  }
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
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [, ivPart, sealedPart] = parts;
  if (!ivPart || !sealedPart) return null;

  // Whichever secret the GCM tag accepts, provided it is the one the
  // enclosed credential would have been sealed under.
  let envelope: SealedPolicyEnvelope | undefined;
  for (const secret of [sealSecret(), legacySecret()]) {
    if (!secret) continue;
    const plaintext = decryptEnvelope(secret, ivPart, sealedPart);
    if (!plaintext) continue;
    if (plaintext.byteLength > MAX_SEALED_PLAINTEXT_BYTES) return null;
    try {
      envelope = JSON.parse(plaintext.toString("utf8"));
    } catch {
      return null;
    }
    const alg =
      typeof envelope?.t === "string" ? harnessCredentialAlg(envelope.t) : null;
    if (
      (alg === "HS256" || alg === "RS256") &&
      expectedSecret(envelope!.t) !== secret
    )
      return null;
    break;
  }
  if (!envelope) return null;
  if (!envelope || ![1, 2, 3, 4, 5, 6].includes(envelope.v) || parts[0] !== `mcpjps${envelope.v}`) return null;
  const bridged =
    envelope.v === 5 || (envelope.v === 6 && envelope.d === "bridge");
  if (envelope.v === 6 && (
    typeof envelope.ck !== "string" || !envelope.ck || envelope.ck.length > 512 ||
    (envelope.d !== undefined && envelope.d !== "bridge")
  )) return null;
  if (envelope.v === 3 && (
    typeof envelope.turn?.laneId !== "string" || !envelope.turn.laneId ||
    typeof envelope.turn?.leaseId !== "string" || !envelope.turn.leaseId
  )) return null;
  // A bridged session envelope without a valid profile fails here.
  const profile =
    envelope.v === 2 ||
    bridged ||
    ((envelope.v === 3 || envelope.v === 4 || envelope.v === 6) &&
      envelope.profile !== undefined)
      ? harnessConnectionProfileSchema.safeParse(envelope.profile)
      : undefined;
  if (profile && !profile.success) return null;
  if (typeof envelope.t !== "string" || envelope.t.length === 0) return null;
  if (typeof envelope.s !== "string" || envelope.s !== serverId) return null;
  if (envelope.v >= 4) {
    // A session envelope never expires: the route checks the live turn.
    if (envelope.exp !== undefined) return null;
  } else {
    if (typeof envelope.exp !== "number") return null;
    // Same NumericDate semantics as the inner token: expired AT `exp`.
    if (Math.floor((opts.nowMs ?? Date.now()) / 1000) >= envelope.exp) {
      return null;
    }
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

  return {
    token: envelope.t,
    ...(envelope.v === 3 ? { turn: envelope.turn } : {}),
    ...(envelope.v >= 4 ? { session: true as const } : {}),
    ...(bridged ? { delivery: "bridge" as const } : {}),
    ...(envelope.v === 6 ? { correlationKey: envelope.ck } : {}),
    serverId: envelope.s,
    policy,
    ...(profile?.success
      ? {
          profile:
            envelope.vn === "legacy-first"
              ? { ...profile.data, versionNegotiation: envelope.vn }
              : profile.data,
        }
      : {}),
  };
}
