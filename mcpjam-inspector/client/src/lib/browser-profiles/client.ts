import { authFetch } from "@/lib/session-token";

export interface BrowserProfile {
  profileId: string;
  projectId: string;
  name: string;
  bytes: number;
  savedFrom: string;
  isDefaultForUser: boolean;
  createdAt: number;
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await authFetch(`/api/web/browser-profiles/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    (T & { error?: unknown }) | null;
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : "The browser profile request failed.",
    );
  }
  return payload as T;
}

export async function listBrowserProfiles(
  projectId: string,
): Promise<BrowserProfile[]> {
  const result = await postJson<{ profiles?: unknown }>("list", { projectId });
  return Array.isArray(result.profiles)
    ? (result.profiles as BrowserProfile[])
    : [];
}

export async function setBrowserProfileDefault(args: {
  projectId: string;
  profileId: string;
}): Promise<void> {
  await postJson("default", args);
}

export async function deleteBrowserProfile(args: {
  projectId: string;
  profileId: string;
}): Promise<void> {
  await postJson("delete", args);
}

/** Upload an archive into Convex storage and commit its profile metadata. */
export async function saveBrowserProfile(args: {
  projectId: string;
  name: string;
  savedFrom: string;
  archive: Blob;
}): Promise<BrowserProfile> {
  const { uploadUrl } = await postJson<{ uploadUrl?: unknown }>("upload-url", {
    projectId: args.projectId,
  });
  if (typeof uploadUrl !== "string" || !uploadUrl) {
    throw new Error("The browser profile upload URL was not returned.");
  }
  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: args.archive,
    redirect: "error",
  });
  if (!upload.ok) {
    throw new Error("The browser profile archive could not be uploaded.");
  }
  const storageId = (await upload.json().catch(() => null)) as {
    storageId?: unknown;
  } | null;
  if (typeof storageId?.storageId !== "string" || !storageId.storageId) {
    throw new Error("The browser profile upload did not return a storage id.");
  }
  const result = await postJson<{ profile?: unknown }>("commit", {
    projectId: args.projectId,
    name: args.name,
    savedFrom: args.savedFrom,
    storageId: storageId.storageId,
  });
  if (!result.profile || typeof result.profile !== "object") {
    throw new Error("The browser profile was not created.");
  }
  return result.profile as BrowserProfile;
}
