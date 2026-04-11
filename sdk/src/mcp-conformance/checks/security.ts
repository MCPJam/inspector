import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type {
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../types.js";
import {
  failedResult,
  skippedResult,
  passedResult,
} from "./helpers.js";

type RawHttpResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: unknown;
};

const SECURITY_CHECK_METADATA = {
  "localhost-host-rebinding-rejected": {
    id: "localhost-host-rebinding-rejected",
    category: "security",
    title: "Reject Evil Host Header",
    description:
      "Local servers reject initialize requests with a non-localhost Host/Origin header.",
  },
  "localhost-host-valid-accepted": {
    id: "localhost-host-valid-accepted",
    category: "security",
    title: "Accept Valid Local Host Header",
    description:
      "Local servers accept initialize requests with a valid localhost Host/Origin header.",
  },
} as const satisfies Record<
  Extract<
    MCPCheckId,
    "localhost-host-rebinding-rejected" | "localhost-host-valid-accepted"
  >,
  Pick<MCPCheckResult, "id" | "category" | "title" | "description">
>;

function isLocalhostUrl(serverUrl: string): boolean {
  const hostname = new URL(serverUrl).hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function getHostFromUrl(serverUrl: string): string {
  return new URL(serverUrl).host;
}

function parseResponseBody(text: string): unknown {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function sendRequest(
  serverUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<RawHttpResponse> {
  const target = new URL(serverUrl);
  const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: "mcpjam-sdk-conformance",
        version: "1.0.0",
      },
    },
  });

  return await new Promise<RawHttpResponse>((resolve, reject) => {
    const req = requestImpl(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: parseResponseBody(Buffer.concat(chunks).toString("utf8")),
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function buildBaseHeaders(ctx: RawHttpCheckContext): Record<string, string> {
  return {
    ...(ctx.config.customHeaders ?? {}),
    ...(ctx.config.accessToken
      ? { Authorization: `Bearer ${ctx.config.accessToken}` }
      : {}),
  };
}

export async function runSecurityChecks(
  ctx: RawHttpCheckContext,
  selectedCheckIds: Set<MCPCheckId>,
): Promise<MCPCheckResult[]> {
  const results: MCPCheckResult[] = [];

  if (
    !selectedCheckIds.has("localhost-host-rebinding-rejected") &&
    !selectedCheckIds.has("localhost-host-valid-accepted")
  ) {
    return results;
  }

  if (!isLocalhostUrl(ctx.serverUrl)) {
    for (const id of [
      "localhost-host-rebinding-rejected",
      "localhost-host-valid-accepted",
    ] as const) {
      if (selectedCheckIds.has(id)) {
        results.push(
          skippedResult(
            SECURITY_CHECK_METADATA[id],
            "Security host-header checks only apply to localhost servers",
            {
              serverUrl: ctx.serverUrl,
            },
          ),
        );
      }
    }

    return results;
  }

  const baseHeaders = buildBaseHeaders(ctx);
  const validHost = getHostFromUrl(ctx.serverUrl);

  if (selectedCheckIds.has("localhost-host-rebinding-rejected")) {
    const startedAt = Date.now();
    try {
      const response = await sendRequest(
        ctx.serverUrl,
        {
          ...baseHeaders,
          Host: "evil.example.com",
          Origin: "http://evil.example.com",
        },
        ctx.config.checkTimeout,
      );
      const rejected =
        response.statusCode >= 400 && response.statusCode < 500;
      results.push(
        rejected
          ? passedResult(
              SECURITY_CHECK_METADATA["localhost-host-rebinding-rejected"],
              Date.now() - startedAt,
              {
                statusCode: response.statusCode,
                body: response.body as Record<string, unknown> | string | undefined,
              },
            )
          : failedResult(
              SECURITY_CHECK_METADATA["localhost-host-rebinding-rejected"],
              Date.now() - startedAt,
              `Expected a 4xx response for invalid Host/Origin headers, got ${response.statusCode}`,
              {
                statusCode: response.statusCode,
                body: response.body as Record<string, unknown> | string | undefined,
              },
            ),
      );
    } catch (error) {
      results.push(
        failedResult(
          SECURITY_CHECK_METADATA["localhost-host-rebinding-rejected"],
          Date.now() - startedAt,
          error instanceof Error ? error.message : String(error),
          undefined,
          error,
        ),
      );
    }
  }

  if (selectedCheckIds.has("localhost-host-valid-accepted")) {
    const startedAt = Date.now();
    try {
      const response = await sendRequest(
        ctx.serverUrl,
        {
          ...baseHeaders,
          Host: validHost,
          Origin: `http://${validHost}`,
        },
        ctx.config.checkTimeout,
      );
      const accepted =
        response.statusCode >= 200 && response.statusCode < 300;
      results.push(
        accepted
          ? passedResult(
              SECURITY_CHECK_METADATA["localhost-host-valid-accepted"],
              Date.now() - startedAt,
              {
                statusCode: response.statusCode,
                body: response.body as Record<string, unknown> | string | undefined,
              },
            )
          : failedResult(
              SECURITY_CHECK_METADATA["localhost-host-valid-accepted"],
              Date.now() - startedAt,
              `Expected a 2xx response for valid localhost headers, got ${response.statusCode}`,
              {
                statusCode: response.statusCode,
                body: response.body as Record<string, unknown> | string | undefined,
              },
            ),
      );
    } catch (error) {
      results.push(
        failedResult(
          SECURITY_CHECK_METADATA["localhost-host-valid-accepted"],
          Date.now() - startedAt,
          error instanceof Error ? error.message : String(error),
          undefined,
          error,
        ),
      );
    }
  }

  return results;
}
