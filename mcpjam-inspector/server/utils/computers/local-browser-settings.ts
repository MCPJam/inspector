import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const enableClients = makeFunctionReference<
  "mutation",
  Record<string, never>,
  {
    enabledProjects: number;
    skippedProjects: number;
  }
>("hosts:enableLocalBrowserForManagedProjects");
const readSetting = makeFunctionReference<
  "query",
  { projectId: string },
  {
    enabled: boolean | null;
  }
>("hosts:getLocalBrowserSettings");

function client(bearer: string) {
  if (!process.env.CONVEX_URL) throw new Error("CONVEX_URL is not configured");
  const convex = new ConvexHttpClient(process.env.CONVEX_URL);
  convex.setAuth(bearer.replace(/^Bearer\s+/i, "").trim());
  return convex;
}

export async function enableLocalBrowserClients(bearer: string): Promise<{
  enabledProjects: number;
  skippedProjects: number;
}> {
  return client(bearer).mutation(enableClients, {});
}

export async function readLocalBrowserSetting(
  bearer: string,
  projectId: string,
): Promise<boolean | undefined> {
  const result = await client(bearer).query(readSetting, { projectId });
  return result.enabled ?? undefined;
}
