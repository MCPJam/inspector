import { HOSTED_MODE } from "@/lib/config";
import { authFetch } from "@/lib/session-token";
import { proxyFetch } from "@/lib/oauth/state-machines/shared/helpers";
import { createXAAStateMachine } from "./state-machine";
import type {
  BaseXAAStateMachineConfig,
  XAARequestExecutor,
  XAARequestResult,
  XAAStateMachine,
} from "./types";

const XAA_API_BASE = HOSTED_MODE ? "/api/web/xaa" : "/api/mcp/xaa";

function responseHeadersToRecord(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.entries());
}

async function readResponseBody(response: Response): Promise<any> {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  try {
    return await response.text();
  } catch {
    return null;
  }
}

export function createXAADebugRequestExecutor(): XAARequestExecutor {
  return {
    internalRequest: async (
      path: string,
      init?: RequestInit,
    ): Promise<XAARequestResult> => {
      const response = await authFetch(`${XAA_API_BASE}${path}`, init);
      const body = await readResponseBody(response);

      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeadersToRecord(response),
        body,
        ok: response.ok,
      };
    },
    externalRequest: async (
      url: string,
      init?: RequestInit,
    ): Promise<XAARequestResult> => {
      const response = await proxyFetch(url, init);
      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: response.body,
        ok: response.ok,
      };
    },
  };
}

export function createInspectorXAAStateMachine(
  config: Omit<BaseXAAStateMachineConfig, "issuerBaseUrl" | "requestExecutor">,
): XAAStateMachine {
  return createXAAStateMachine({
    ...config,
    issuerBaseUrl: `${window.location.origin}${XAA_API_BASE}`,
    requestExecutor: createXAADebugRequestExecutor(),
  });
}
