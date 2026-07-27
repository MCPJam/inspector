import { webPost } from "./base";
import { buildServerRequest } from "./context";
import { webPostWithMrtr } from "./mrtr-api";

export async function listHostedResources(request: {
  serverNameOrId: string;
  cursor?: string;
}): Promise<any> {
  const serverRequest = buildServerRequest(request.serverNameOrId);
  return webPost("/api/web/resources/list", {
    ...serverRequest,
    cursor: request.cursor,
  });
}

export async function readHostedResource(request: {
  serverNameOrId: string;
  uri: string;
}): Promise<any> {
  const serverRequest = buildServerRequest(request.serverNameOrId);
  // MRTR-capable (§12.5): a modern `resources/read` can return
  // `input_required`. Rounds are collected on the shared dialog rail and the
  // resumed result keeps the `{ content }` envelope of a first-try read.
  return webPostWithMrtr(
    "/api/web/resources/read",
    {
      ...serverRequest,
      uri: request.uri,
    },
    {
      serverNameOrId: request.serverNameOrId,
      wrapResult: (content) => ({ content }),
    },
  );
}
