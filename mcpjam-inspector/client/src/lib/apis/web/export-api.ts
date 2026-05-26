import { webPost } from "./base";
import { buildServerRequest } from "./context";

export async function exportHostedServer(serverNameOrId: string): Promise<any> {
  const serverRequest = buildServerRequest(serverNameOrId);
  return webPost("/api/web/export/server", serverRequest);
}
