/**
 * Profile-picture and organization-logo uploads.
 *
 * The image bytes go to the backend's upload routes, which check what the
 * bytes actually are (PNG, JPEG, GIF or WebP — nothing else), store them
 * under that type, and set the picture in one step. The browser never holds
 * a storage upload URL, and the checks here only exist to give a fast, clear
 * answer before a round trip: the backend enforces the same rules.
 */

export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** For `<input type="file" accept={IMAGE_UPLOAD_ACCEPT}>`. */
export const IMAGE_UPLOAD_ACCEPT = ALLOWED_IMAGE_TYPES.join(",");

export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;

export const IMAGE_TYPE_MESSAGE = "Choose a PNG, JPEG, GIF, or WebP image.";
export const IMAGE_SIZE_MESSAGE = "Choose an image that is 5 MB or smaller.";

/** Why a file cannot be uploaded, or null when it can. */
export function validateImageFile(file: Pick<File, "type" | "size">) {
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(type)) {
    return IMAGE_TYPE_MESSAGE;
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    return IMAGE_SIZE_MESSAGE;
  }
  return null;
}

export type ImageUploadTarget =
  | { kind: "profile-picture" }
  | { kind: "organization-logo"; organizationId: string };

export class ImageUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ImageUploadError";
  }
}

const FALLBACK_MESSAGE = "The image could not be uploaded. Try again.";

function uploadUrl(siteUrl: string, target: ImageUploadTarget): URL {
  const base = siteUrl.replace(/\/$/, "");
  if (target.kind === "profile-picture") {
    return new URL(`${base}/web/uploads/profile-picture`);
  }
  const url = new URL(`${base}/web/uploads/organization-logo`);
  url.searchParams.set("organizationId", target.organizationId);
  return url;
}

/**
 * Upload `file` as the target picture. Resolves with the new picture's URL;
 * rejects with an {@link ImageUploadError} whose message can be shown as-is.
 */
export async function uploadImage(args: {
  /** Convex HTTP actions base URL (`getConvexSiteUrl()`). */
  siteUrl: string;
  /** Convex bearer for the signed-in user. */
  bearerToken: string;
  target: ImageUploadTarget;
  file: File;
  fetchImpl?: typeof fetch;
}): Promise<{ url: string | null }> {
  const problem = validateImageFile(args.file);
  if (problem) throw new ImageUploadError(problem, 0, "INVALID_FILE");

  const fetchImpl = args.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(uploadUrl(args.siteUrl, args.target), {
      method: "POST",
      headers: {
        "Content-Type": args.file.type,
        Authorization: `Bearer ${args.bearerToken}`,
      },
      body: args.file,
    });
  } catch {
    throw new ImageUploadError(FALLBACK_MESSAGE, 0, null);
  }

  const payload = (await response.json().catch(() => null)) as {
    ok?: unknown;
    url?: unknown;
    error?: unknown;
    code?: unknown;
  } | null;
  if (!response.ok || payload?.ok !== true) {
    throw new ImageUploadError(
      typeof payload?.error === "string" && payload.error
        ? payload.error
        : FALLBACK_MESSAGE,
      response.status,
      typeof payload?.code === "string" ? payload.code : null,
    );
  }
  return { url: typeof payload.url === "string" ? payload.url : null };
}
