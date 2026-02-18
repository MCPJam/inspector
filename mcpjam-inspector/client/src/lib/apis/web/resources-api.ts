import { webPost } from "./base";
import { buildHostedServerRequest } from "./context";

export async function listHostedResources(request: {
  serverNameOrId: string;
  cursor?: string;
}): Promise<any> {
  const serverRequest = buildHostedServerRequest(request.serverNameOrId);
  return webPost("/api/web/resources/list", {
    ...serverRequest,
    cursor: request.cursor,
  });
}

export async function readHostedResource(request: {
  serverNameOrId: string;
  uri: string;
}): Promise<any> {
  const serverRequest = buildHostedServerRequest(request.serverNameOrId);
  return webPost("/api/web/resources/read", {
    ...serverRequest,
    uri: request.uri,
  });
}
