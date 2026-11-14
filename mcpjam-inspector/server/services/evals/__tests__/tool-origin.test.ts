import { expect, it } from "vitest";
import { evalTraceSpanZ } from "@/shared/eval-trace";
import {
  createAiSdkEvalTraceContext,
  registerAiSdkPrepareStep,
  wrapToolSetForEvalTrace,
} from "../eval-trace-capture";

it.each(["mcp", "builtin", "unknown"] as const)(
  "persists %s provenance through real execution and ingestion",
  async (origin) => {
    const context = createAiSdkEvalTraceContext(Date.now());
    registerAiSdkPrepareStep(context, 0);
    const tools = wrapToolSetForEvalTrace(
      {
        bash: {
          ...(origin === "mcp" ? { _serverId: "server" } : {}),
          ...(origin === "builtin" ? { _toolOrigin: "builtin" } : {}),
          execute: async (_input: unknown, _options: { toolCallId: string }) =>
            "done",
        },
      },
      context,
    );
    await tools.bash.execute({}, { toolCallId: "call" });
    const span = context.recordedSpans.find((span) => span.category === "tool");
    expect(evalTraceSpanZ.parse(span).toolOrigin).toBe(origin);
  },
);
