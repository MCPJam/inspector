import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBuiltinToolRun } from "../use-builtin-tool-run";
import { useAgentToolPromptBridge } from "@/stores/agent-tool-prompt-bridge";
import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";

const bash: HarnessBuiltinToolInfo = {
  key: "bash",
  name: "Bash",
  description: "Execute a shell command",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: { command: { type: "string" } },
  },
};
const glob: HarnessBuiltinToolInfo = { key: "glob", name: "Glob" };

describe("useBuiltinToolRun", () => {
  beforeEach(() => useAgentToolPromptBridge.setState({ pending: null }));
  afterEach(() => useAgentToolPromptBridge.setState({ pending: null }));

  it("selecting a tool generates its parameter form", () => {
    const { result } = renderHook(() => useBuiltinToolRun([bash]));
    expect(result.current.selected).toBeNull();
    act(() => result.current.select("bash"));
    expect(result.current.selected?.key).toBe("bash");
    expect(result.current.fields.map((f) => f.name)).toContain("command");
  });

  it("askAgentToRun requests a structured prompt (not direct execution)", () => {
    const { result } = renderHook(() => useBuiltinToolRun([bash]));
    act(() => result.current.select("bash"));
    act(() => result.current.onFieldChange("command", "ls -la"));
    act(() => result.current.askAgentToRun());

    const pending = useAgentToolPromptBridge.getState().pending;
    expect(pending).not.toBeNull();
    expect(pending!.prompt).toContain("Use the Bash tool");
    expect(pending!.prompt).toContain('"command": "ls -la"');
  });

  it("works for a no-parameter tool", () => {
    const { result } = renderHook(() => useBuiltinToolRun([glob]));
    act(() => result.current.select("glob"));
    act(() => result.current.askAgentToRun());
    expect(useAgentToolPromptBridge.getState().pending!.prompt).toContain(
      "Use the Glob tool",
    );
  });

  it("clear() deselects", () => {
    const { result } = renderHook(() => useBuiltinToolRun([bash]));
    act(() => result.current.select("bash"));
    act(() => result.current.clear());
    expect(result.current.selected).toBeNull();
  });
});
