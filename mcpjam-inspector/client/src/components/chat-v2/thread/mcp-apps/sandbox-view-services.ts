import { z } from "zod";
import { SandboxViewAdmissionError } from "@mcpjam/widget-react";
import type {
  PreparedSandboxView,
  PrepareSandboxViewRequest,
  ReleaseSandboxViewRequest,
} from "@mcpjam/sdk/widget-runtime";
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import { MCPJAM_PLATFORM_SERVER_ID } from "@/shared/mcpjam-agent-widgets.js";
import { buildServerRequest } from "@/lib/apis/web/context";

const preparedViewSchema = z.object({
  admissionId: z.string().min(1).max(128),
  proxyUrl: z.string().url(),
  htmlSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().finite().positive(),
});
const admissionIdSchema = preparedViewSchema.pick({ admissionId: true });

export function createSandboxViewServices(
  forceWeb: () => boolean,
  serverContext: (serverId: string) => Record<string, unknown> = buildServerRequest,
) {
  const endpoints = new Map<string, { endpoint: string; context: Record<string, unknown> }>();
  const prepareSandboxView = async (
    request: PrepareSandboxViewRequest,
    signal?: AbortSignal,
  ): Promise<PreparedSandboxView> => {
    const platform = request.source.serverId === MCPJAM_PLATFORM_SERVER_ID;
    const web = HOSTED_MODE || forceWeb() || platform;
    const endpoint = `/api/${web ? "web/apps" : "apps"}/mcp-apps/view-admissions`;
    const context = { source: request.source, ...(web && !platform ? serverContext(request.source.serverId) : {}) };
    const response = await authFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        ...request,
        ...context,
      }),
    });
    if (!response.ok) throw new SandboxViewAdmissionError(response.status === 429 || response.status >= 500);
    const value: unknown = await response.json();
    const created = admissionIdSchema.safeParse(value);
    if (created.success) endpoints.set(created.data.admissionId, { endpoint, context });
    try {
      const prepared = preparedViewSchema.parse(value);
      if (prepared.expiresAt <= Date.now()) throw new SandboxViewAdmissionError();
      const url = new URL(prepared.proxyUrl);
      const isolatedLocalhost = z.uuid().safeParse(prepared.admissionId).success &&
        url.hostname === `${prepared.admissionId}.localhost`;
      const loopback = isolatedLocalhost || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if (
        (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
        url.origin === request.hostOrigin || url.username || url.password || url.hash
      ) throw new SandboxViewAdmissionError();
      return prepared;
    } catch {
      if (created.success) {
        void releaseSandboxView(created.data).catch(() => {
          // The server also expires the lease if cleanup is temporarily unavailable.
        });
      }
      throw new SandboxViewAdmissionError();
    }
  };
  const releaseSandboxView = async ({ admissionId }: ReleaseSandboxViewRequest) => {
    const admission = endpoints.get(admissionId);
    if (!admission) return;
    try {
      const response = await authFetch(`${admission.endpoint}/${encodeURIComponent(admissionId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(admission.context),
      });
      if (!response.ok && response.status !== 404) throw new SandboxViewAdmissionError();
    } finally {
      endpoints.delete(admissionId);
    }
  };
  return { prepareSandboxView, releaseSandboxView };
}
