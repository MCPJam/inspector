import { z } from "zod";
import { checkedSandboxPolicy, sandboxDigest } from "./sandbox-view-policy.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const sandboxViewLeaseSchema = z.object({
  keyHash: digest,
  ownerHash: digest,
  sourceHash: digest,
  htmlHash: digest,
  policyHash: digest,
  identityHash: digest,
  hostOrigin: z.string().url(),
  viewOrigin: z.string().url(),
  policy: z.string(),
  generation: z.string().min(1).max(128),
  expiresAt: z.number().finite().int().positive(),
});
export type SandboxViewLease = z.infer<typeof sandboxViewLeaseSchema>;
export type SandboxViewLeaseInput = Omit<
  SandboxViewLease,
  "identityHash" | "generation" | "expiresAt"
>;
export function sandboxViewIdentity(
  lease: Omit<SandboxViewLease, "identityHash" | "expiresAt">,
): string {
  return sandboxDigest(
    JSON.stringify([
      lease.keyHash,
      lease.ownerHash,
      lease.sourceHash,
      lease.htmlHash,
      lease.policyHash,
      lease.hostOrigin,
      lease.viewOrigin,
      lease.policy,
      lease.generation,
    ]),
  );
}
export function validateSandboxViewLease(value: unknown): SandboxViewLease {
  const lease = sandboxViewLeaseSchema.parse(value);
  checkedSandboxPolicy(lease.policy);
  if (
    sandboxDigest(lease.policy) !== lease.policyHash ||
    sandboxViewIdentity(lease) !== lease.identityHash
  )
    throw new Error("App document lease integrity check failed");
  for (const origin of [lease.hostOrigin, lease.viewOrigin])
    if (
      !["http:", "https:"].includes(new URL(origin).protocol) ||
      new URL(origin).origin !== origin
    )
      throw new Error("App document lease origin is invalid");
  return lease;
}
