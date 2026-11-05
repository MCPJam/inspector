import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import {
  buildCSP,
  PERMISSIVE_SANDBOX_CSP,
} from "../utils/sandbox-csp-policy.js";
import {
  deriveLabeledKey,
  resolveSigningKeyRing,
} from "../utils/signing-keys.js";
import { getSessionToken } from "./session-token.js";
import { HOSTED_MODE } from "../config.js";

export const SANDBOX_VIEW_LEASE_MS = 2 * 60 * 60 * 1000;
export const SANDBOX_VIEW_MAX_HTML_BYTES = 8 * 1024 * 1024;
export const SANDBOX_VIEW_MAX_HEADER_BYTES = 8 * 1024;
const TOKEN_LABEL = "mcpjam:sandbox-view:v1";
const MAX_TOKEN_BYTES = 32 * 1024;
const cleanToken = z
  .string()
  .max(2048)
  .refine(
    (value) => !/[^\x20-\x7e]/.test(value),
    "CSP values must use printable ASCII",
  );
export function isSandboxDomainSource(value: string): boolean {
  if (!value || /[\s,;\'"<>\\]/.test(value)) return false;
  if (value === "*" || /^[A-Za-z][A-Za-z0-9+.-]*:$/.test(value)) return true;
  try {
    const input = value.includes("://") ? value : `https://${value}`;
    const parsed = new URL(input.replace(/:\*(?=\/|$)/, ":443"));
    const hostname = parsed.hostname;
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !hostname
    )
      return false;
    if (hostname.startsWith("[")) return hostname.endsWith("]");
    if (hostname === "*") return true;
    const labels = (hostname.startsWith("*.") ? hostname.slice(2) : hostname)
      .replace(/\.$/, "")
      .split(".");
    return labels.every((label) =>
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    );
  } catch {
    return false;
  }
}
const domains = z
  .array(
    cleanToken.refine(
      isSandboxDomainSource,
      "CSP domains must be individual source expressions",
    ),
  )
  .max(128)
  .optional();
const cspSchema = z
  .object({
    connectDomains: domains,
    resourceDomains: domains,
    frameDomains: domains,
    baseUriDomains: domains,
  })
  .strict();
const subtypesSchema = z
  .object({
    cspConnectDomains: z
      .object({
        fetch: z.boolean().optional(),
        xhr: z.boolean().optional(),
        websocket: z.boolean().optional(),
      })
      .strict()
      .optional(),
    cspResourceDomains: z
      .object({
        script: z.boolean().optional(),
        stylesheet: z.boolean().optional(),
        image: z.boolean().optional(),
        font: z.boolean().optional(),
        media: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const sandboxViewSourceSchema = z
  .object({
    serverId: z.string().min(1).max(1024),
    resourceUri: z.string().min(1).max(8192),
    toolCallId: z.string().min(1).max(1024),
  })
  .strict();
export const sandboxViewPolicySchema = z
  .object({
    csp: cspSchema.nullable().optional(),
    cspDirectives: z
      .record(z.string().max(128), z.array(cleanToken).max(128))
      .optional(),
    cspSubtypePolicy: subtypesSchema.optional(),
    permissive: z.boolean(),
  })
  .strict();
export const prepareSandboxViewSchema = z.object({
  viewInstanceId: z.string().uuid(),
  admissionId: z.string().uuid().optional(),
  source: sandboxViewSourceSchema,
  sourceReceipt: z.string().max(MAX_TOKEN_BYTES).optional(),
  html: z
    .string()
    .max(SANDBOX_VIEW_MAX_HTML_BYTES)
    .refine(
      (value) => Buffer.byteLength(value) <= SANDBOX_VIEW_MAX_HTML_BYTES,
      "App HTML exceeds the supported size",
    ),
  policy: sandboxViewPolicySchema,
  mode: z.enum(["declared", "debugger"]),
  hostOrigin: z.string().url().max(2048),
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceClaimSchema = z
  .object({
    kind: z.literal("source"),
    version: z.literal(1),
    owner: digest,
    source: digest,
    html: digest,
    policy: z.string().max(SANDBOX_VIEW_MAX_HEADER_BYTES),
    issuedAt: z.number().int(),
    expiresAt: z.number().int(),
  })
  .strict();
const claimSchema = sourceClaimSchema;
export type SandboxSourceClaim = z.infer<typeof sourceClaimSchema>;
export type SandboxViewInput = z.infer<typeof prepareSandboxViewSchema>;

export function sandboxDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
export function sandboxSourceDigest(
  source: z.infer<typeof sandboxViewSourceSchema>,
): string {
  return sandboxDigest(
    JSON.stringify([source.serverId, source.resourceUri, source.toolCallId]),
  );
}
function keys(): { signing: Buffer; accepted: readonly Buffer[] } {
  const configured = resolveSigningKeyRing({
    secretEnv: "SANDBOX_VIEW_SIGNING_SECRET",
    label: TOKEN_LABEL,
  });
  if (configured) return configured;
  const local =
    !HOSTED_MODE && deriveLabeledKey(getSessionToken(), TOKEN_LABEL);
  if (!local) throw new Error("App document signing is not configured");
  return { signing: local, accepted: [local] };
}
export function sealSandboxClaim(claim: SandboxSourceClaim): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys().signing, iv);
  cipher.setAAD(Buffer.from(TOKEN_LABEL));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(claim), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    encrypted.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}
export function openSandboxClaim(token: string): SandboxSourceClaim {
  if (token.length > MAX_TOKEN_BYTES)
    throw new Error("Invalid App document capability");
  const parts = token.split(".");
  if (
    parts.length !== 4 ||
    parts[0] !== "v1" ||
    parts.slice(1).some((value) => !/^[A-Za-z0-9_-]+$/.test(value))
  )
    throw new Error("Invalid App document capability");
  if (
    parts
      .slice(1)
      .some(
        (part) => Buffer.from(part, "base64url").toString("base64url") !== part,
      )
  )
    throw new Error("Invalid App document capability");
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[3], "base64url");
  if (iv.length !== 12 || tag.length !== 16)
    throw new Error("Invalid App document capability");
  for (const key of keys().accepted) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(TOKEN_LABEL));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(parts[2], "base64url")),
        decipher.final(),
      ]);
      return claimSchema.parse(JSON.parse(plaintext.toString("utf8")));
    } catch {
      // A key ring can contain an old key; only a fully authenticated claim is accepted.
    }
  }
  throw new Error("Invalid App document capability");
}
export function checkedSandboxPolicy(policy: string): string {
  if (
    !policy ||
    /[^\x20-\x7e]/.test(policy) ||
    Buffer.byteLength(policy) > SANDBOX_VIEW_MAX_HEADER_BYTES
  )
    throw new Error("App CSP is invalid or exceeds the supported size");
  return policy;
}
export function issueSandboxSourceReceipt(
  owner: string,
  source: z.infer<typeof sandboxViewSourceSchema>,
  html: string,
  csp: unknown,
): string {
  const metadata = cspSchema.nullable().optional().parse(csp);
  const now = Date.now();
  return sealSandboxClaim({
    kind: "source",
    version: 1,
    owner,
    source: sandboxSourceDigest(source),
    html: sandboxDigest(html),
    policy: checkedSandboxPolicy(buildCSP(metadata)),
    issuedAt: now,
    expiresAt: now + SANDBOX_VIEW_LEASE_MS,
  });
}

export function resolveSandboxViewPolicy(
  input: SandboxViewInput,
  owner: string,
  allowExpiredReceipt = false,
): string {
  const requested = input.policy.permissive
    ? PERMISSIVE_SANDBOX_CSP
    : buildCSP(
        input.policy.csp,
        input.policy.cspDirectives,
        input.policy.cspSubtypePolicy,
      );
  let baseline = buildCSP();
  if (input.sourceReceipt) {
    const claim = openSandboxClaim(input.sourceReceipt);
    if (
      claim.kind !== "source" ||
      (!allowExpiredReceipt && claim.expiresAt <= Date.now()) ||
      claim.owner !== owner ||
      claim.source !== sandboxSourceDigest(input.source) ||
      claim.html !== sandboxDigest(input.html)
    )
      throw new Error("App resource receipt no longer matches this view");
    baseline = claim.policy;
  }
  if (input.mode === "debugger") return checkedSandboxPolicy(requested);
  if (input.policy.permissive)
    throw new Error("Declared-policy Apps cannot request permissive rendering");
  // Multiple HTTP CSP policies are intersected by the browser, so host overrides cannot widen declared resource policy.
  return checkedSandboxPolicy(`${baseline}, ${requested}`);
}

/** Opaque digests only; all source metadata stays in the authenticated lease store. */
export function sealSandboxViewCapability(
  keyHash: string,
  identityHash: string,
  origin: string,
): string {
  const body = JSON.stringify(["view1", keyHash, identityHash, origin]);
  const mac = createHmac("sha256", keys().signing)
    .update(body)
    .digest("base64url");
  return ["view1", keyHash, identityHash, mac].join(".");
}
export function openSandboxViewCapability(
  token: string,
  origin: string,
): { keyHash: string; identityHash: string } {
  const [version, keyHash, identityHash, signature, extra] = token.split(".");
  if (
    version !== "view1" ||
    extra !== undefined ||
    !/^[a-f0-9]{64}$/.test(keyHash ?? "") ||
    !/^[a-f0-9]{64}$/.test(identityHash ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature ?? "")
  )
    throw new Error("Invalid App document capability");
  const body = JSON.stringify([version, keyHash, identityHash, origin]);
  const supplied = Buffer.from(signature, "base64url");
  if (
    supplied.toString("base64url") !== signature ||
    !keys().accepted.some((key) =>
      timingSafeEqual(
        createHmac("sha256", key).update(body).digest(),
        supplied,
      ),
    )
  )
    throw new Error("Invalid App document capability");
  return { keyHash, identityHash };
}
