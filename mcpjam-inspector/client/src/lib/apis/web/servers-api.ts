import { webPost } from "./base";
import { buildHostedServerRequest } from "./context";

export interface HostedServerValidateResponse {
  success: boolean;
  status?: string;
}

export async function validateHostedServer(
  serverNameOrId: string,
): Promise<HostedServerValidateResponse> {
  const request = buildHostedServerRequest(serverNameOrId);
  return webPost<typeof request, HostedServerValidateResponse>(
    "/api/web/servers/validate",
    request,
  );
}
