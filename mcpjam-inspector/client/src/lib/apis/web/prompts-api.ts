import { webPost } from "./base";
import {
  buildServerBatchRequest,
  buildServerRequest,
} from "./context";
import { webPostWithMrtr } from "./mrtr-api";

export async function listHostedPrompts(request: {
  serverNameOrId: string;
  cursor?: string;
}): Promise<any> {
  const serverRequest = buildServerRequest(request.serverNameOrId);
  return webPost("/api/web/prompts/list", {
    ...serverRequest,
    cursor: request.cursor,
  });
}

export async function listHostedPromptsMulti(request: {
  serverNamesOrIds: string[];
}): Promise<any> {
  const batchRequest = buildServerBatchRequest(request.serverNamesOrIds);
  return webPost("/api/web/prompts/list-multi", batchRequest);
}

export async function getHostedPrompt(request: {
  serverNameOrId: string;
  promptName: string;
  arguments?: Record<string, string>;
}): Promise<any> {
  const serverRequest = buildServerRequest(request.serverNameOrId);
  // MRTR-capable (§12.5): a modern `prompts/get` can return `input_required`.
  // Rounds are collected on the shared dialog rail and the resumed result is
  // returned in the same `{ content }` envelope a first-try get produces.
  return webPostWithMrtr(
    "/api/web/prompts/get",
    {
      ...serverRequest,
      promptName: request.promptName,
      arguments: request.arguments,
    },
    {
      serverNameOrId: request.serverNameOrId,
      wrapResult: (content) => ({ content }),
    },
  );
}
