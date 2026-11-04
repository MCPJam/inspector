import { logger } from "./logger.js";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import {
  callViewWebmcpTool,
  listViewWebmcpTools,
  type AppToolDescriptor,
} from "@mcpjam/sdk/widget-runtime";
import { validateDeclaredArgs } from "../../shared/declared-tools.js";
import { ViewActionQueue } from "./webmcp-view/action-queue.js";
import type { ViewToolsPageApi } from "./webmcp-view/view-tools-page.js";
import type { WidgetToolCall } from "./mcp-app-browser-harness.js";

export interface ViewToolCallRecord {
  viewId: string;
  serverId: string;
  resourceUri?: string;
  rawName: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  widgetToolCalls: WidgetToolCall[];
  followUps: string[];
}
interface ViewMount {
  viewId: string;
  serverId: string;
  resourceUri?: string;
}

/** Node owns mount identity, argument validation, deadlines and call evidence. */
export class McpAppViewTools {
  private readonly queue = new ViewActionQueue();
  private listedView: string | null = null;
  private tools: AppToolDescriptor[] = [];
  private records: ViewToolCallRecord[] = [];
  constructor(
    private readonly io: {
      enabled: boolean;
      onCall?: (call: ViewToolCallRecord) => void;
      page: () => Page | null;
      mount: () => ViewMount | null;
      dismiss: (viewId: string) => Promise<void>;
      beginAction: () => void;
      drain: () => Promise<{
        widgetToolCalls: WidgetToolCall[];
        followUps: string[];
      }>;
    },
  ) {}

  get available(): boolean {
    return this.tools.length > 0 && this.listedView === this.io.mount()?.viewId;
  }
  invalidate(): void {
    this.listedView = null;
    this.tools = [];
    this.queue.invalidate();
  }
  drainRecords(): ViewToolCallRecord[] {
    return this.records.splice(0);
  }

  async runAction<T>(
    viewId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.io.enabled) return operation();
    return this.queue.run(
      async () => {
        this.requireMount(viewId);
        return operation();
      },
      { signal, onUncertainStop: () => this.dismissCurrent(viewId) },
    );
  }

  async list(
    signal?: AbortSignal,
  ): Promise<{ viewId: string; tools: AppToolDescriptor[] } | null> {
    if (!this.io.enabled) return null;
    const mount = this.io.mount();
    if (!mount) return null;
    return this.queue.run(
      async (innerSignal) => {
        const tools = await this.readTools(mount.viewId, innerSignal);
        this.requireMount(mount.viewId);
        this.tools = tools;
        this.listedView = mount.viewId;
        return { viewId: mount.viewId, tools };
      },
      { signal, onUncertainStop: () => this.dismissCurrent(mount.viewId) },
    );
  }

  async call(
    viewId: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (!this.io.enabled) throw new Error("View tools are unavailable");
    if (new TextEncoder().encode(JSON.stringify(args)).length > 256 * 1024)
      throw new Error("View tool arguments exceed the limit");
    return this.queue.run(
      async (innerSignal) => {
        const mount = this.requireMount(viewId);
        const tools = await this.readTools(viewId, innerSignal);
        const descriptor = tools.find((tool) => tool.name === name);
        if (!descriptor)
          throw new Error("Unknown view tool; list view tools again");
        const validation = validateDeclaredArgs(descriptor.inputSchema, args);
        if (!validation.ok) throw new Error("Invalid view tool arguments");
        this.requireMount(viewId);
        this.io.beginAction();
        const record: ViewToolCallRecord = {
          ...mount,
          rawName: name,
          arguments: args,
          ok: false,
          widgetToolCalls: [],
          followUps: [],
        };
        innerSignal.throwIfAborted();
        this.records.push(record);
        this.io.onCall?.(record);
        try {
          const result = await callViewWebmcpTool(
            {
              request: () =>
                this.remote(viewId, "call", name, args, innerSignal),
            },
            name,
            args,
          );
          record.ok = result.isError !== true;
          return result;
        } finally {
          Object.assign(record, await this.io.drain());
        }
      },
      { signal, onUncertainStop: () => this.dismissCurrent(viewId) },
    );
  }

  private requireMount(viewId: string): ViewMount {
    const mount = this.io.mount();
    if (!mount || mount.viewId !== viewId)
      throw Object.assign(new Error("View replaced; list view tools again"), {
        code: -32603,
      });
    return mount;
  }
  private async dismissCurrent(viewId: string) {
    if (this.io.mount()?.viewId === viewId) await this.io.dismiss(viewId);
  }
  private async readTools(viewId: string, signal: AbortSignal) {
    const tools = await listViewWebmcpTools({
      request: () => this.remote(viewId, "list", "", {}, signal),
    });
    if (
      tools.some(
        (tool) =>
          new TextEncoder().encode(JSON.stringify(tool.inputSchema)).length >
            8192 || (tool.description?.length ?? 0) > 512,
      )
    ) {
      throw new Error("View tool descriptor exceeds the limit");
    }
    return tools;
  }
  private async remote(
    viewId: string,
    method: "list" | "call",
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    this.requireMount(viewId);
    const page = this.io.page();
    if (!page) throw new Error("View is unavailable");
    const requestId = randomUUID();
    const cancel = () => {
      void page
        .evaluate(
          ({ viewId, requestId }) =>
            window.__mcpjamViewTools.cancel(viewId, requestId),
          { viewId, requestId },
        )
        .catch((error: unknown) => {
          logger.warn(
            "[view-tools] Cancellation transport failed; closing view",
            { error },
          );
        });
    };
    signal.throwIfAborted();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await page.evaluate(
        ({ viewId, requestId, method, name, args }) => {
          const api: ViewToolsPageApi = window.__mcpjamViewTools;
          return method === "list"
            ? api.list(viewId, requestId)
            : api.call(viewId, requestId, name, args);
        },
        { viewId, requestId, method, name, args },
      );
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}
