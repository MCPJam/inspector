import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import { getApiAuthorizationHeader } from "@/lib/apis/web/context";
import {
  extractionResultSchema,
  type MarkdownSaveRequest,
  type MarkdownSaveResult,
} from "@/shared/markdown-case-import";

async function post(path: string, body: object, signal?: AbortSignal) {
  const authorization = await getApiAuthorizationHeader();
  if (!authorization) throw new Error("Sign in to import cases.");
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
      "The import service returned an invalid response. Your Markdown file was not the problem. Please try again.",
    );
  }
  if (!response.ok) {
    throw new Error(
      typeof data?.error === "string"
        ? data.error
        : (data?.error?.message ??
            data?.message ??
            "Markdown import failed. Please try again."),
    );
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
      "The save response was incomplete. Retry the same save to confirm which cases were imported.",
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
      "The save response could not be matched to the selected cases. Retry the same save.",
    );
  }
  return result;
}
