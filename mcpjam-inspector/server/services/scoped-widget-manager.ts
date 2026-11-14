import type { Context } from "hono";
import { z } from "zod";
import type { RenderWidgetForRequestParams } from "../utils/widget-render-core.js";
import { createManualHostedConnection } from "../routes/web/auth.js";
import { WidgetSessionBusyError } from "./widget-render-session.js";

type Manager = RenderWidgetForRequestParams["mcpClientManager"];
const scopeSchema = z.object({
  projectId: z.string(),
  serverId: z.string(),
  clientCapabilities: z.record(z.string(), z.unknown()).optional(),
});

/** A retained page gets a connection only during its current authorized request. */
export class ScopedWidgetManager {
  constructor(private readonly clientCapabilities?: Record<string, unknown>) {}

  private current?: Manager;
  private busy = false;
  private closed = false;
  readonly manager: Manager = {
    listTools: (...args) => this.active().listTools(...args),
    executeTool: (serverId, name, args) => this.active().executeTool(serverId, name, args),
    readResource: (...args) => this.active().readResource(...args),
  };

  private active() {
    if (!this.current || this.closed)
      throw new Error("Widget has no active authorized request.");
    return this.current;
  }

  async run<T>(
    c: Context,
    scope: { projectId: string; serverId: string },
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.busy) throw new WidgetSessionBusyError("Widget session is busy.");
    if (this.closed) throw new Error("Widget session is closed.");
    this.busy = true;
    let connected:
      | Awaited<ReturnType<typeof createManualHostedConnection>>
      | undefined;
    try {
      connected = await createManualHostedConnection(
        c,
        {
          projectId: scope.projectId,
          serverId: scope.serverId,
          ...(this.clientCapabilities
            ? { clientCapabilities: this.clientCapabilities }
            : {}),
        },
        scopeSchema,
      );
      c.req.raw.signal.throwIfAborted();
      if (this.closed) throw new Error("Widget session is closed.");
      this.current = connected.manager;
      return await work();
    } finally {
      this.current = undefined;
      try {
        await connected?.manager.disconnectAllServers();
      } finally {
        this.busy = false;
      }
    }
  }

  close() {
    this.closed = true;
    this.current = undefined;
  }
}
