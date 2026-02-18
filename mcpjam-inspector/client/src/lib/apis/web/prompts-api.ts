import { webPost } from "./base";
import {
  buildHostedServerBatchRequest,
  buildHostedServerRequest,
} from "./context";

export async function listHostedPrompts(request: {
  serverNameOrId: string;
  cursor?: string;
}): Promise<any> {
  const serverRequest = buildHostedServerRequest(request.serverNameOrId);
  return webPost("/api/web/prompts/list", {
    ...serverRequest,
    cursor: request.cursor,
  });
}

export async function listHostedPromptsMulti(request: {
  serverNamesOrIds: string[];
}): Promise<any> {
  const batchRequest = buildHostedServerBatchRequest(request.serverNamesOrIds);
  return webPost("/api/web/prompts/list-multi", batchRequest);
}

export async function getHostedPrompt(request: {
  serverNameOrId: string;
  promptName: string;
  arguments?: Record<string, string>;
}): Promise<any> {
  const serverRequest = buildHostedServerRequest(request.serverNameOrId);
  return webPost("/api/web/prompts/get", {
    ...serverRequest,
    promptName: request.promptName,
    arguments: request.arguments,
  });
}
