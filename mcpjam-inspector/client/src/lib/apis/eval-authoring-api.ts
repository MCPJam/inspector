import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import { getApiAuthorizationHeader } from "@/lib/apis/web/context";
import { notifyMCPJamLimitError } from "@/lib/mcpjam-limit";
import {
  evalAuthoringDraftSchema,
  type EvalAuthoringDraft,
} from "@mcpjam/sdk/contract";

export class AuthoringRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type AuthoringStatus = {
  jobId: string;
  availableTools?: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    serverId?: string;
  }>;
  suiteServers?: string[];
  /** How the job was started. An import is followed on its own surface. */
  source?: "markdown" | "generation" | "agent" | "import";
  status: "pending" | "completed" | "failed" | "cancelled";
  phase: string;
  error: string | null;
  warnings: string[];
  drafts: EvalAuthoringDraft[];
};
export async function authoringRequest(
  body: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const authorization = await getApiAuthorizationHeader();
  if (!authorization) throw new Error("Sign in to author cases.");
  const response = await authFetch(
    `/api/${HOSTED_MODE ? "web" : "mcp"}/evals/authoring-v1`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body,
        ...(!HOSTED_MODE
          ? { convexAuthToken: authorization.replace(/^Bearer /i, "") }
          : {}),
      }),
      signal,
    },
  );
  const data = await response.json();
  if (!response.ok) {
    const message =
      typeof data.error === "string"
        ? data.error
        : data.error?.message ?? "Case authoring failed.";
    notifyMCPJamLimitError({ code: data.code, details: data, message });
    throw new AuthoringRequestError(message, response.status);
  }
  return data;
}
export async function readAuthoringJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<AuthoringStatus> {
  const data = await authoringRequest({ operation: "status", jobId }, signal);
  return {
    ...data,
    drafts: data.drafts.map((draft: unknown) =>
      evalAuthoringDraftSchema.parse(draft),
    ),
  };
}
