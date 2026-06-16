import { HOSTED_MODE } from "@/lib/config";
import { authFetch } from "@/lib/session-token";
import { createDebugRequestExecutor } from "@/lib/oauth/debug-state-machine-adapter";
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

function normalizeHeaders(
  headers?: HeadersInit | Record<string, string>,
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.map(([key, value]) => [key, String(value)]),
    );
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  );
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
  const debugRequestExecutor = createDebugRequestExecutor();

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
      return debugRequestExecutor({
        url,
        method: init?.method || "GET",
        headers: normalizeHeaders(init?.headers),
        body: init?.body,
      });
    },
  };
}

export function createInspectorXAAStateMachine(
  config: Omit<BaseXAAStateMachineConfig, "issuerBaseUrl" | "requestExecutor"> & {
    // Ground-truth issuer resolved from the server's OpenID config. Falls back
    // to the browser-origin guess, which is wrong when the browser reaches the
    // API through the Vite dev proxy (browser :5173, backend :6274).
    issuerBaseUrl?: string;
  },
): XAAStateMachine {
  const { issuerBaseUrl, ...rest } = config;
  return createXAAStateMachine({
    ...rest,
    issuerBaseUrl: issuerBaseUrl ?? `${window.location.origin}${XAA_API_BASE}`,
    requestExecutor: createXAADebugRequestExecutor(),
  });
}
