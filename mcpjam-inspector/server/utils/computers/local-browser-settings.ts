import { ConvexHttpClient } from "convex/browser";

function client(bearer: string) {
  if (!process.env.CONVEX_URL) throw new Error("CONVEX_URL is not configured");
  const convex = new ConvexHttpClient(process.env.CONVEX_URL);
  convex.setAuth(bearer.replace(/^Bearer\s+/i, ""));
  return convex;
}

export async function enableLocalBrowserClients(bearer: string): Promise<{
  enabledProjects: number;
  skippedProjects: number;
}> {
  return client(bearer).mutation("hosts:enableLocalBrowserForManagedProjects" as never, {});
}

export async function readLocalBrowserSetting(bearer: string, projectId: string): Promise<boolean | undefined> {
  const result = await client(bearer).query("hosts:getLocalBrowserSettings" as never, { projectId }) as { enabled: boolean | null };
  return result.enabled ?? undefined;
}
