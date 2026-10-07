import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  HarnessActivityGroup,
  isHarnessActivityPart,
  segmentHarnessActivity,
} from "../harness-activity-group";
import { useHarnessLiveOutputStore } from "@/stores/harness-live-output-store";

const tool = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  state = "output-available",
  extra: Record<string, unknown> = {},
) =>
  ({
    type: `tool-${toolName}`,
    toolCallId,
    state,
    input,
    ...(state === "output-available" ? { output: "ok" } : {}),
    ...extra,
  }) as any;

const never = () => false;

describe("isHarnessActivityPart", () => {
  it("a built-in call is activity", () => {
    expect(
      isHarnessActivityPart(tool("1", "bash", { command: "ls" }), {}, never),
    ).toBe(true);
  });

  it("an MCP server's tool is not, even under a built-in's name", () => {
    expect(
      isHarnessActivityPart(
        tool("1", "read", {}, "output-available", {
          callProviderMetadata: { mcpjam: { serverId: "srv" } },
        }),
        {},
        never,
      ),
    ).toBe(false);
    expect(
      isHarnessActivityPart(
        tool("1", "read", {}),
        { read: "srv" } as any,
        never,
      ),
    ).toBe(false);
    expect(
      isHarnessActivityPart(tool("1", "create_issue", {}), {}, never),
    ).toBe(false);
  });

  it("a call waiting on approval, or one an override claims, is not", () => {
    expect(
      isHarnessActivityPart(
        tool("1", "bash", {}, "approval-requested"),
        {},
        never,
      ),
    ).toBe(false);
    expect(
      isHarnessActivityPart(tool("1", "bash", {}), {}, (id) => id === "1"),
    ).toBe(false);
  });

  it("text and data parts are not", () => {
    expect(isHarnessActivityPart({ type: "text", text: "hi" }, {}, never)).toBe(
      false,
    );
  });
});

describe("segmentHarnessActivity", () => {
  const isActivity = (part: any) => part.type === "tool-bash";

  it("gathers each run, keyed by its first call, and keeps the rest in place", () => {
    const parts = [
      { type: "text", text: "Looking." },
      { type: "tool-bash", toolCallId: "a" },
      { type: "text", text: "" },
      { type: "tool-bash", toolCallId: "b" },
      { type: "text", text: "Found it." },
      { type: "tool-bash", toolCallId: "c" },
    ];
    const segments = segmentHarnessActivity(parts, isActivity);
    expect(
      segments.map((s) =>
        s.kind === "activity"
          ? `activity:${s.key}:${s.parts.length}`
          : `part:${s.index}`,
      ),
    ).toEqual(["part:0", "activity:a:2", "part:4", "activity:c:1"]);
  });
});

describe("HarnessActivityGroup", () => {
  beforeEach(() => {
    useHarnessLiveOutputStore.setState({ outputs: {} });
  });

  const renderGroup = (parts: any[]) =>
    render(
      <HarnessActivityGroup
        parts={parts}
        renderPart={(part) => (
          <div data-testid={`card-${part.toolCallId}`}>card</div>
        )}
      />,
    );

  it("a finished run is one summary row; open it for each call's card", () => {
    renderGroup([
      tool("a", "bash", { command: "npm test" }),
      tool("b", "read", { file_path: "/w/app.ts" }),
      tool("c", "read", { file_path: "/w/b.ts" }, "output-error"),
    ]);
    expect(screen.getByText("Ran a command, read 2 files")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.queryByTestId("card-a")).toBeNull();

    fireEvent.click(screen.getByText("Ran a command, read 2 files"));
    // The cards themselves, in order: each says what its call did.
    expect(
      ["card-a", "card-b", "card-c"].map((id) => screen.getByTestId(id)),
    ).toHaveLength(3);
  });

  it("while a call runs, the row names it and shows its live output", () => {
    renderGroup([
      tool("a", "read", { file_path: "/w/app.ts" }),
      tool("b", "bash", { command: "npm test" }, "input-available"),
    ]);
    expect(screen.getByText("Run")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText("2 steps")).toBeInTheDocument();
    expect(screen.queryByTestId("harness-live-output")).toBeNull();
    act(() => {
      const { append } = useHarnessLiveOutputStore.getState();
      for (let i = 1; i <= 8; i++) append("b", `line ${i}\n`);
    });
    // The last few lines only.
    expect(screen.getByTestId("harness-live-output").textContent).toBe(
      ["line 3", "line 4", "line 5", "line 6", "line 7", "line 8"].join("\n"),
    );
  });
});
