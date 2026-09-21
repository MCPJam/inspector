import { ERROR_MESSAGES } from "@/lib/error-messages";
import { authFetch } from "@/lib/session-token";
import { notifyMCPJamLimitError } from "@/lib/mcpjam-limit";
import { HOSTED_MODE } from "@/lib/config";
import { getApiAuthorizationHeader } from "@/lib/apis/web/context";
import {
  extractionResultSchema,
  type MarkdownSaveRequest,
  type MarkdownSaveResult,
} from "@/shared/markdown-case-import";

async function post(path: string, body: object, signal?: AbortSignal) {
  const authorization = await getApiAuthorizationHeader();
  if (!authorization) throw new Error(ERROR_MESSAGES.signInToImportCases);
  const response = await authFetch(
    `/api/${HOSTED_MODE ? "web" : "mcp"}/evals/${path}`,
    {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body,
        ...(!HOSTED_MODE
          ? { convexAuthToken: authorization.replace(/^Bearer /i, "") }
          : {}),
      }),
    },
  );
  return readImportResponse(response);
}

async function readImportResponse(response: Response) {
  let data;
  try {
    data = JSON.parse(await response.text());
  } catch {
    throw new Error(
      ERROR_MESSAGES.theImportServiceReturnedAnInvalidResponseYourMarkdownFile,
    );
  }
  if (!response.ok) {
    const message =
      typeof data?.error === "string"
        ? data.error
        : (data?.error?.message ??
          data?.message ??
          "Markdown import failed. Please try again.");
    // Import is the third surface that can be refused for a spent MCPJam
    // allowance, and the only one that never raised the wall — the module
    // posts through `authFetch` directly rather than `postEvalRequest`, which
    // is where chat and the eval routes get this for free. Both `post()`
    // callers funnel through here, so `saveMarkdownCases` (and its second
    // consumer in `mcpjam-agent/eval-workspace.ts`) is covered too.
    //
    // Deliberately NOT `notifyMCPJamLimitErrorFromResponse`: the body is
    // already consumed by the `response.text()` above, so the `.clone()`
    // inside that helper would throw — and it swallows the throw, leaving a
    // message that matches no limit pattern and a wall that never opens. The
    // parsed body carries everything the classifier needs.
    notifyMCPJamLimitError({
      code: typeof data?.code === "string" ? data.code : undefined,
      // The whole body, so the deep scan can find `organizationId` and route
      // the dialog's "Buy credits" at the org that actually hit the cap.
      details: data,
      message,
      // Forwarded so a transient concurrency throttle keeps its inline retry
      // instead of being sold credits it cannot spend.
      limitKind:
        data?.limitKind === "total" || data?.limitKind === "concurrency"
          ? data.limitKind
          : undefined,
    });
    throw new Error(message);
  }
  return data;
}

export async function extractMarkdownCases(
  body: {
    projectId: string;
    suiteId: string;
    markdown: string;
    fileName: string;
  },
  signal: AbortSignal,
) {
  // Keep the browser request same-origin. The server forwards the bearer to
  // Convex; extraction must not depend on the backend's browser CORS policy.
  return extractionResultSchema.parse(
    await post("extract-markdown", body, signal),
  );
}
export async function saveMarkdownCases(
  body: MarkdownSaveRequest,
): Promise<MarkdownSaveResult> {
  const result = await post("import-markdown", body);
  if (
    !Array.isArray(result.committed) ||
    !Array.isArray(result.failed) ||
    result.committed.length + result.failed.length !== body.cases.length
  ) {
    throw new Error(
      ERROR_MESSAGES.theSaveResponseWasIncompleteRetryTheSameSaveTo,
    );
  }
  const indices = [...result.committed, ...result.failed].map(
    (entry) => entry.index,
  );
  if (
    indices.some(
      (index) =>
        !Number.isInteger(index) || index < 0 || index >= body.cases.length,
    ) ||
    new Set(indices).size !== body.cases.length
  ) {
    throw new Error(
      ERROR_MESSAGES.theSaveResponseCouldNotBeMatchedToTheSelected,
    );
  }
  return result;
}
