import { z } from "zod";
import type { RequestOptions } from "./client.js";
import { PlatformApiError } from "./errors.js";
import type { PlatformDeletionReceipt } from "./types.js";

const capabilitySchema = z.object({ available: z.boolean(), protocolVersion: z.literal(1),
  scopeTypes: z.array(z.enum(["project", "organization"])), });
export type PlatformDeletionCapabilities = z.infer<typeof capabilitySchema>;
export type PlatformProjectDeletion = PlatformDeletionReceipt | { id: string; deleted: boolean };
type Transport = <T>(method: "GET" | "POST" | "DELETE", path: string,
  init: { body?: unknown }, options?: RequestOptions) => Promise<T>;

export async function requestDeletion(transport: Transport,
  scope: { type: "project" | "organization"; id: string },
  options: RequestOptions & { idempotencyKey: string }): Promise<PlatformDeletionReceipt> {
  const capability = capabilitySchema.parse(await transport("GET", "/deletions/capabilities", {}, options));
  if (!capability.available) {
    throw new PlatformApiError("Deletion requests are not available yet.", "FEATURE_NOT_SUPPORTED", { status: 422 });
  }
  return transport("POST", "/deletions", { body: { scope } }, options);
}

export async function deleteProject(transport: Transport, projectId: string,
  options: RequestOptions = {}): Promise<PlatformProjectDeletion> {
  const capability = capabilitySchema.parse(await transport("GET", "/deletions/capabilities", {}, options));
  if (!capability.available) {
    return transport("DELETE", `/projects/${encodeURIComponent(projectId)}`, {}, options);
  }
  if (!options.idempotencyKey) {
    throw new PlatformApiError("A reusable deletion request key is required.", "VALIDATION_ERROR", { status: 400 });
  }
  return transport("POST", "/deletions", { body: { scope: { type: "project", id: projectId } } }, options);
}
