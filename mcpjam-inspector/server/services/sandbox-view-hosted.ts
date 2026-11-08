import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import { reportRouteFailure } from "../utils/route-error-report.js";
import type { PreparedSandboxView } from "@mcpjam/sdk/widget-runtime";
import { SANDBOX_HOSTS } from "../config.js";
import { sandboxOriginOf } from "../../shared/sandbox-origin.js";
import {
  getServiceCredential,
  INSPECTOR_SERVICE_TOKEN_HEADER,
} from "./service-credential.js";
import {
  sandboxViewLeaseSchema,
  validateSandboxViewLease,
  type SandboxViewLease,
  type SandboxViewLeaseInput,
} from "./sandbox-view-lease.js";
import {
  checkedSandboxPolicy,
  resolveSandboxViewPolicy,
  sandboxDigest,
  sandboxSourceDigest,
  sealSandboxViewCapability,
  type SandboxViewInput,
} from "./sandbox-view-policy.js";

function unavailable(error: unknown): never {
  reportRouteFailure("App document lease service failed", error, {
    source: "apps.view-lease",
    hop: "mcpjam_internal",
  });
  throw new WebRouteError(
    503,
    ErrorCode.INTERNAL_ERROR,
    "App documents are temporarily unavailable. Try again.",
  );
}
async function service(
  operation: "create" | "read" | "renew" | "release",
  body: unknown,
): Promise<unknown> {
  const base = process.env.CONVEX_HTTP_URL;
  const credential = getServiceCredential();
  if (!base || !credential)
    throw new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      "Hosted App document leases are not configured.",
    );
  const response = await fetch(
    `${base}/internal/v1/sandbox-view-leases/${operation}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INSPECTOR_SERVICE_TOKEN_HEADER]: credential,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    },
  ).catch(unavailable);
  if (operation === "read" && response.status === 409) return null;
  if (!response.ok)
    throw new WebRouteError(
      response.status === 409 ? 409 : 503,
      response.status === 409 ? ErrorCode.CONFLICT : ErrorCode.INTERNAL_ERROR,
      "App document lease is unavailable. Reopen the App and try again.",
    );
  return response.json().catch(unavailable);
}
function unpack(value: unknown): SandboxViewLease {
  if (!value || typeof value !== "object" || !("lease" in value))
    unavailable(new Error("Hosted App document lease response is invalid"));
  const parsed = sandboxViewLeaseSchema.safeParse(value.lease);
  if (!parsed.success)
    unavailable(new Error("Hosted App document lease schema is invalid"));
  return validateSandboxViewLease(parsed.data);
}
function viewOrigin(keyHash: string): string {
  // The sandbox origin the browser is served (`getInspectorClientRuntimeConfig`):
  // a valid MCPJAM_SANDBOX_ORIGIN, else the build-time value.
  const configured =
    sandboxOriginOf(process.env.MCPJAM_SANDBOX_ORIGIN) ??
    process.env.VITE_MCPJAM_SANDBOX_ORIGIN;
  if (!configured)
    throw new Error(
      "Configure the hosted App sandbox origin before opening Apps",
    );
  const base = new URL(configured);
  if (
    base.protocol !== "https:" ||
    base.origin !== configured ||
    !SANDBOX_HOSTS.has(base.hostname)
  )
    throw new Error("The hosted App sandbox origin is not allowed");
  return `https://v-${keyHash.slice(0, 16)}.${base.hostname}`;
}
function response(
  input: SandboxViewInput,
  lease: SandboxViewLease,
): PreparedSandboxView {
  const claim = sealSandboxViewCapability(
    lease.keyHash,
    lease.identityHash,
    lease.viewOrigin,
  );
  return {
    admissionId: input.viewInstanceId,
    proxyUrl: `${lease.viewOrigin}/api/web/apps/mcp-apps/sandbox-proxy?view_token=${claim}`,
    htmlSha256: lease.htmlHash,
    expiresAt: lease.expiresAt,
  };
}
export async function prepareHostedSandboxView(
  input: SandboxViewInput,
  ownerHash: string,
): Promise<PreparedSandboxView> {
  const keyHash = sandboxDigest(
    JSON.stringify([ownerHash, input.viewInstanceId]),
  );
  const found = await service("read", { keyHash, ownerHash });
  const existing = found ? unpack(found) : undefined;
  if (!existing && input.admissionId)
    throw new Error("App admission is no longer active; reopen the App");
  const policy = checkedSandboxPolicy(
    `${resolveSandboxViewPolicy(input, ownerHash, existing !== undefined)}, frame-ancestors 'self' ${input.hostOrigin}`,
  );
  const expected: SandboxViewLeaseInput = {
    keyHash,
    ownerHash,
    sourceHash: sandboxSourceDigest(input.source),
    htmlHash: sandboxDigest(input.html),
    policyHash: sandboxDigest(policy),
    hostOrigin: input.hostOrigin,
    viewOrigin: viewOrigin(keyHash),
    policy,
  };
  if (existing) {
    for (const key of Object.keys(expected) as Array<
      keyof SandboxViewLeaseInput
    >)
      if (existing[key] !== expected[key])
        throw new Error("App admission changed; reopen the App");
    const renewed = unpack(
      await service("renew", {
        keyHash,
        ownerHash,
        identityHash: existing.identityHash,
      }),
    );
    if (renewed.identityHash !== existing.identityHash)
      throw new Error("App admission identity changed while renewing");
    return response(input, renewed);
  }
  const created = unpack(await service("create", expected));
  for (const key of Object.keys(expected) as Array<keyof SandboxViewLeaseInput>)
    if (created[key] !== expected[key])
      throw new Error("Hosted App document lease differs from its admission");
  return response(input, created);
}
export async function readHostedSandboxView(
  keyHash: string,
  identityHash: string,
): Promise<SandboxViewLease | undefined> {
  const result = await service("read", { keyHash, identityHash });
  return result ? unpack(result) : undefined;
}
export async function releaseHostedSandboxView(
  admissionId: string,
  ownerHash: string,
): Promise<void> {
  const keyHash = sandboxDigest(JSON.stringify([ownerHash, admissionId]));
  const result = await service("read", { keyHash, ownerHash });
  if (!result) return;
  const lease = unpack(result);
  await service("release", {
    keyHash,
    ownerHash,
    identityHash: lease.identityHash,
  });
}
