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
  if (payload === null) {
    throw new Error("The browser profile request failed.");
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

/**
 * Upload an archive and commit its profile metadata. The archive's bytes go
 * to the inspector, which stores them and answers with the storage id alone
 * (MJ-006).
 */
export async function saveBrowserProfile(args: {
  projectId: string;
  name: string;
  savedFrom: string;
  archive: Blob;
}): Promise<BrowserProfile> {
  const upload = await authFetch(
    `/api/web/browser-profiles/upload?projectId=${encodeURIComponent(
      args.projectId,
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: args.archive,
    },
  );
  const uploaded = (await upload.json().catch(() => null)) as {
    storageId?: unknown;
    message?: unknown;
    error?: unknown;
  } | null;
  if (!upload.ok) {
    throw new Error(
      typeof uploaded?.message === "string"
        ? uploaded.message
        : typeof uploaded?.error === "string"
          ? uploaded.error
          : "The browser profile archive could not be uploaded.",
    );
  }
  if (typeof uploaded?.storageId !== "string" || !uploaded.storageId) {
    throw new Error("The browser profile upload did not return a storage id.");
  }
  const result = await postJson<{ profile?: unknown }>("commit", {
    projectId: args.projectId,
    name: args.name,
    savedFrom: args.savedFrom,
    storageId: uploaded.storageId,
  });
  if (!result.profile || typeof result.profile !== "object") {
    throw new Error("The browser profile was not created.");
  }
  return result.profile as BrowserProfile;
}
