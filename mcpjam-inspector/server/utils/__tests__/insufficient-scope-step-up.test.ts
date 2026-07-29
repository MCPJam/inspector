import { InsufficientScopeError } from "@modelcontextprotocol/client";
import type { UIMessageChunk } from "ai";
import { describe, expect, it, vi } from "vitest";
import { wrapToolsWithScopeStepUp } from "../insufficient-scope-step-up.js";

type CapturedChunk = {
  type: string;
  transient?: boolean;
  data: Record<string, unknown>;
};

function makeWriter() {
  const chunks: CapturedChunk[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: UIMessageChunk) => {
        chunks.push(chunk as unknown as CapturedChunk);
      },
    },
  };
}

describe("wrapToolsWithScopeStepUp", () => {
  it("emits an actionable insufficient_scope chunk and rethrows", async () => {
    const error = new InsufficientScopeError({
      requiredScope: "bench:write",
      resourceMetadataUrl: new URL(
        "https://bench.example/.well-known/oauth-protected-resource",
      ),
    });
    const { chunks, writer } = makeWriter();
    const wrapped = wrapToolsWithScopeStepUp(
      {
        bench_write: {
          description: "Write to the bench",
          inputSchema: {},
          _serverId: "auth-bench",
          execute: vi.fn(async () => {
            throw error;
          }),
        },
      } as any,
      () => writer,
    );

    await expect(
      wrapped.bench_write.execute?.({}, { toolCallId: "call-1" } as any),
    ).rejects.toBe(error);
    expect(chunks).toEqual([
      {
        type: "data-elicitation",
        transient: true,
        data: {
          kind: "insufficient_scope",
          serverId: "auth-bench",
          toolCallId: "call-1",
          requiredScope: "bench:write",
          resourceMetadataUrl:
            "https://bench.example/.well-known/oauth-protected-resource",
        },
      },
    ]);
    expect(chunks[0]?.data).not.toHaveProperty("serverName");
  });

  it("suppresses an errorDescription-only challenge and rethrows", async () => {
    const error = new InsufficientScopeError({
      errorDescription: "More access is required",
    });
    const { chunks, writer } = makeWriter();
    const wrapped = wrapToolsWithScopeStepUp(
      {
        bench_write: {
          inputSchema: {},
          execute: async () => {
            throw error;
          },
        },
      } as any,
      () => writer,
    );

    await expect(wrapped.bench_write.execute?.({}, {} as any)).rejects.toBe(
      error,
    );
    expect(chunks).toHaveLength(0);
  });

  it("ignores ordinary tool errors and rethrows", async () => {
    const error = new Error("tool failed");
    const { chunks, writer } = makeWriter();
    const wrapped = wrapToolsWithScopeStepUp(
      {
        bench_write: {
          inputSchema: {},
          execute: async () => {
            throw error;
          },
        },
      } as any,
      () => writer,
    );

    await expect(wrapped.bench_write.execute?.({}, {} as any)).rejects.toBe(
      error,
    );
    expect(chunks).toHaveLength(0);
  });

  it("rethrows without crashing when the writer is not ready", async () => {
    const error = new InsufficientScopeError({
      requiredScope: "bench:write",
    });
    const wrapped = wrapToolsWithScopeStepUp(
      {
        bench_write: {
          inputSchema: {},
          execute: async () => {
            throw error;
          },
        },
      } as any,
      () => null,
    );

    await expect(wrapped.bench_write.execute?.({}, {} as any)).rejects.toBe(
      error,
    );
  });

  it("shares extraction and gating with custom hosted observers", async () => {
    const error = new InsufficientScopeError({
      requiredScope: "bench:write",
      errorDescription: "Write access required",
    });
    const onToolError = vi.fn();
    const emitInsufficientScope = vi.fn();
    const wrapped = wrapToolsWithScopeStepUp(
      {
        bench_write: {
          inputSchema: {},
          _serverId: "server-1",
          execute: async () => {
            throw error;
          },
        },
      } as any,
      () => null,
      { onToolError, emitInsufficientScope },
    );

    await expect(
      wrapped.bench_write.execute?.({}, { toolCallId: "call-1" } as any),
    ).rejects.toBe(error);
    expect(onToolError).toHaveBeenCalledWith({
      error,
      serverId: "server-1",
      toolCallId: "call-1",
    });
    expect(emitInsufficientScope).toHaveBeenCalledWith({
      serverId: "server-1",
      toolCallId: "call-1",
      requiredScope: "bench:write",
      resourceMetadataUrl: undefined,
      errorDescription: "Write access required",
    });
  });

  it("preserves successful results and tools without execute", async () => {
    const result = { content: [{ type: "text", text: "ok" }] };
    const withoutExecute = {
      description: "Provider-executed tool",
      inputSchema: {},
    };
    const wrapped = wrapToolsWithScopeStepUp(
      {
        bench_read: {
          inputSchema: {},
          execute: async () => result,
        },
        provider_tool: withoutExecute,
      } as any,
      () => null,
    );

    await expect(wrapped.bench_read.execute?.({}, {} as any)).resolves.toBe(
      result,
    );
    expect(wrapped.provider_tool).toBe(withoutExecute);
  });
});
