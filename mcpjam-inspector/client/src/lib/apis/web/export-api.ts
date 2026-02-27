import { webPost } from "./base";
import { buildHostedServerRequest } from "./context";

export async function exportHostedServer(serverNameOrId: string): Promise<any> {
  const serverRequest = buildHostedServerRequest(serverNameOrId);
  return webPost("/api/web/export/server", serverRequest);
}
