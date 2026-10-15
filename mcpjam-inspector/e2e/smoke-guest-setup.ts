import { request, type FullConfig } from "@playwright/test";
import { chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Inherited by workers when they reload the config in their own process. */
export function smokeGuestStorageFile(pid = process.pid) {
  const key = "MCPJAM_E2E_GUEST_STATE_FILE";
  return (process.env[key] ||= join(
    tmpdir(),
    `mcpjam-smoke-guest-${pid}.json`,
  ));
}

/** Fresh browser contexts reuse one guest cookie instead of minting per test. */
export default async function smokeGuestSetup(config: FullConfig) {
  if (process.env.PLAYWRIGHT_BASE_URL) return;
  const { baseURL, storageState } = config.projects[0].use;
  if (!baseURL || typeof storageState !== "string")
    throw new Error(
      "Smoke tests require a local base URL and storage-state file.",
    );
  const origin = new URL(baseURL).origin;
  const client = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: origin },
    storageState: {
      cookies: [],
      origins: [
        {
          origin,
          localStorage: [
            {
              name: "mcpjam.local-access",
              value:
                process.env.MCPJAM_SESSION_TOKEN ??
                "playwright-local-access-credential",
            },
          ],
        },
      ],
    },
  });
  let saved = false;
  try {
    const response = await client.post("/api/web/guest-session", { data: {} });
    if (!response.ok())
      throw new Error(
        `Smoke guest setup was refused (HTTP ${response.status()}).`,
      );
    await client.storageState({ path: storageState });
    await chmod(storageState, 0o600);
    saved = true;
    return () => rm(storageState, { force: true });
  } finally {
    await client.dispose();
    if (!saved) await rm(storageState, { force: true });
  }
}

/** API-driven smoke tests use the same guest identity as browser contexts. */
export async function smokeGuestBearer(baseURL: string, origin: string) {
  const client = await request.newContext({
    baseURL,
    storageState: process.env.MCPJAM_E2E_GUEST_STATE_FILE || undefined,
  });
  try {
    const response = await client.post("/api/web/guest-session", {
      headers: { Origin: origin },
      data: {},
    });
    if (!response.ok()) return undefined;
    const body: unknown = await response.json();
    return body &&
      typeof body === "object" &&
      "token" in body &&
      typeof body.token === "string"
      ? body.token
      : undefined;
  } finally {
    await client.dispose();
  }
}
