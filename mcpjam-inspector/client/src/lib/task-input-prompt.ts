import { validateEmbeddedClientRequest } from "@mcpjam/sdk/browser";

export interface TaskInputPrompt {
  key: string;
  message: string;
  mode: "form" | "url";
  schema?: Record<string, unknown>;
  url?: string;
}

/** Use the SDK's protocol validation before showing a server-supplied request. */
export function taskInputPrompt(
  requests: Record<string, unknown>,
  answered: ReadonlySet<string>,
): { next: TaskInputPrompt | null; unanswerableCount: number } {
  let next: TaskInputPrompt | null = null;
  let unanswerableCount = 0;
  for (const [key, raw] of Object.entries(requests)) {
    if (answered.has(key)) continue;
    const request = raw as { method?: unknown; params?: unknown } | null;
    if (
      request?.method !== "elicitation/create" ||
      !validateEmbeddedClientRequest("elicitation/create", request.params).ok
    ) {
      unanswerableCount++;
      continue;
    }
    const params = request.params as Record<string, unknown>;
    next ??= {
      key,
      message: params.message as string,
      mode: params.mode === "url" ? "url" : "form",
      ...(params.mode === "url"
        ? { url: params.url as string }
        : { schema: params.requestedSchema as Record<string, unknown> }),
    };
  }
  return { next, unanswerableCount };
}
