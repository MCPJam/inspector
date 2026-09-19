import { classifyToolSafety } from "@mcpjam/sdk/contract";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  GROUNDING_LIMITS,
  record,
  type GroundingProbe,
} from "../../../shared/swarm-grounding";
import { withDeadline } from "../../utils/run-supervisor/deadline";
export const DISCOVERY_LIMITS = GROUNDING_LIMITS;
export function abortable<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Aborted"));
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
export function isZeroArgSchema(schema: unknown): boolean {
  if (schema === undefined) return true;
  const obj = record(schema);
  return (
    !!obj &&
    obj.type === "object" &&
    !obj.allOf &&
    !obj.anyOf &&
    !obj.oneOf &&
    !obj.$ref &&
    !obj.if &&
    (obj.required === undefined ||
      (Array.isArray(obj.required) && obj.required.length === 0))
  );
}
export type DiscoveryTool = {
  serverId: string;
  serverName?: string;
  name: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
};
export function selectDiscoveryTools(tools: DiscoveryTool[]): DiscoveryTool[] {
  const rank = (name: string) =>
    /^(list|get|search|describe)[_-]/i.test(name) ? 0 : 1;
  return tools
    .filter(
      (t) =>
        classifyToolSafety(t.annotations) === "readOnly" &&
        isZeroArgSchema(t.inputSchema),
    )
    .sort(
      (a, b) =>
        rank(a.name) - rank(b.name) ||
        a.name.localeCompare(b.name) ||
        a.serverId.localeCompare(b.serverId),
    )
    .slice(0, DISCOVERY_LIMITS.tools);
}
function truncateUtf8(value: string, bytes: number): string {
  return new TextDecoder().decode(
    new TextEncoder().encode(value).slice(0, bytes),
    { stream: true },
  );
}
export async function probeReadOnlyTools(args: {
  manager: MCPClientManager;
  serverIds: string[];
  serverNames?: string[];
  signal?: AbortSignal;
}) {
  const deadline = withDeadline(
    args.signal,
    DISCOVERY_LIMITS.totalMs,
    "discovery",
  );
  const probes: GroundingProbe[] = [];
  const probedTools: string[] = [];
  let used = 0;
  try {
    const catalog = await abortable(
      Promise.all(
        args.serverIds.map(async (serverId, i) =>
          (
            await args.manager.listTools(serverId, undefined, {
              signal: deadline.signal,
            })
          ).tools.map((tool) => ({
            ...tool,
            serverId,
            serverName: args.serverNames?.[i],
          })),
        ),
      ),
      deadline.signal,
    );
    for (const tool of selectDiscoveryTools(catalog.flat())) {
      if (deadline.signal.aborted || used >= DISCOVERY_LIMITS.totalBytes) break;
      probedTools.push(`${tool.serverId}/${tool.name}`);
      const call = withDeadline(
        deadline.signal,
        DISCOVERY_LIMITS.callMs,
        "toolCall",
      );
      try {
        const result = await abortable(
          args.manager.executeTool(
            tool.serverId,
            tool.name,
            {},
            { signal: call.signal },
          ),
          call.signal,
        );
        if (result.isError === true) continue;
        let remaining = Math.min(
          DISCOVERY_LIMITS.resultBytes,
          DISCOVERY_LIMITS.totalBytes - used,
        );
        const structured = result.structuredContent;
        const structuredBytes =
          structured === undefined
            ? 0
            : new TextEncoder().encode(JSON.stringify(structured)).length;
        const keepStructured =
          structured !== undefined && structuredBytes <= remaining;
        if (keepStructured) remaining -= structuredBytes;
        const text = truncateUtf8(
          Array.isArray(result.content)
            ? result.content
                .flatMap((part) => {
                  const block = record(part);
                  return block?.type === "text" &&
                    typeof block.text === "string"
                    ? [block.text]
                    : [];
                })
                .join("\n")
            : "",
          remaining,
        );
        used +=
          new TextEncoder().encode(text).length +
          (keepStructured ? structuredBytes : 0);
        if (text || keepStructured)
          probes.push({
            serverId: tool.serverId,
            toolName: tool.name,
            ...(tool.serverName ? { serverName: tool.serverName } : {}),
            text,
            ...(keepStructured ? { structuredContent: structured } : {}),
          });
      } catch {
        /* A missing/slow read is unavailable evidence, not a target failure. */
      } finally {
        call.dispose();
      }
    }
    return {
      probes,
      probedTools,
      ...(probedTools.length ? {} : { skippedReason: "no_read_only_tools" }),
    };
  } finally {
    deadline.dispose();
  }
}
