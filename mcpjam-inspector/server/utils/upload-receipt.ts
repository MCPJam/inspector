import { INSPECTOR_SERVICE_TOKEN_HEADER } from "../middleware/internal-service-auth.js";

/** Returned only to the trusted uploader, never to the browser. */
export interface UploadDestination {
  uploadUrl: string;
  uploadGrantId?: string;
}

/** Confirm only the id returned by our own storage POST, never a caller's id. */
export async function confirmUploadedObject(args: {
  convexHttpUrl: string;
  bearer: string;
  serviceToken: string | null;
  uploadGrantId: string | undefined;
  storageId: string;
  signal: AbortSignal;
}): Promise<void> {
  // Supports deploying this uploader before the backend starts issuing grants.
  // Once a grant is issued, a successful receipt is mandatory before returning
  // the storage id or attaching the artifact. No fallback after a refusal.
  if (args.uploadGrantId === undefined) return;
  if (!args.serviceToken)
    throw new Error("Upload receipt requires service credentials");
  const response = await fetch(
    `${args.convexHttpUrl}/internal/v1/uploads/complete`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.bearer}`,
        "Content-Type": "application/json",
        [INSPECTOR_SERVICE_TOKEN_HEADER]: args.serviceToken,
      },
      body: JSON.stringify({
        uploadGrantId: args.uploadGrantId,
        storageId: args.storageId,
      }),
      redirect: "error",
      signal: AbortSignal.any([args.signal, AbortSignal.timeout(10_000)]),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    throw new Error("Upload receipt was refused");
  }
}
