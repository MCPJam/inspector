import { describe, expect, it } from "vitest";
import { adaptTraceToUiMessages } from "@/components/evals/trace-viewer-adapter";
import { SAMPLE_TRACE, SAMPLE_TRACE_VIEWER_MODEL } from "@/components/evals/sample-trace-data";

describe("sample trace data", () => {
  it("adapts to UI messages with greet tool and multiple turns", () => {
    const { messages } = adaptTraceToUiMessages({ trace: SAMPLE_TRACE });
    expect(messages.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(messages);
    expect(serialized).toContain("greet");
    expect(serialized).toContain("Ada");

    expect(SAMPLE_TRACE.spans?.length).toBeGreaterThanOrEqual(3);
    expect(SAMPLE_TRACE_VIEWER_MODEL.provider).toBe("openai");
    expect(SAMPLE_TRACE_VIEWER_MODEL.id).toBe("gpt-4o");
  });
});
