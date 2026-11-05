import { beforeAll, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createClaudeCodeHarness } from "../claude-code-bootstrap.js";

let callbackSource: string;
let abortSource: string;
beforeAll(async () => {
  const bootstrap = await createClaudeCodeHarness().getBootstrap?.();
  const bridge = bootstrap?.files.find((file) =>
    file.path.endsWith("/bridge.mjs"),
  );
  if (!bridge) throw new Error("Missing installed bridge");
  const source = ts.createSourceFile(
    "bridge.mjs",
    bridge.content,
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "onElicitation"
    )
      callbackSource = node.initializer.getText(source);
    if (ts.isCaseClause(node) && node.expression.getText(source) === '"abort"')
      abortSource = node.statements
        .map((statement) => statement.getText(source))
        .join("\n");
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!callbackSource || !abortSource)
    throw new Error("Installed bridge control shape changed");
});

describe("installed Claude bridge elicitation", () => {
  it.each(["accept", "decline", "cancel"] as const)(
    "answers %s through the existing control ID",
    async (action) => {
      const requestToolResult = vi.fn(async () => ({
        output: { action, content: { color: "blue" } },
      }));
      const emit = vi.fn();
      const callback: unknown = runInNewContext(`(${callbackSource})`, {
        turn: { requestToolResult },
        emit,
      });
      if (typeof callback !== "function") throw new Error("Missing callback");
      const result: unknown = await callback(
        { mode: "form" },
        { requestId: "native-id", signal: new AbortController().signal },
      );
      expect(requestToolResult).toHaveBeenCalledExactlyOnceWith({
        toolCallId: "mcpjam:elicitation:native-id",
      });
      expect(result).toEqual(
        action === "accept"
          ? { action, content: { color: "blue" } }
          : { action },
      );
      expect(emit).toHaveBeenCalledExactlyOnceWith({
        type: "raw",
        rawValue: {
          type: "mcpjam:elicitation",
          phase: "request",
          controlId: "mcpjam:elicitation:native-id",
          request: { mode: "form" },
        },
      });
    },
  );

  it("settles elicitation waits on host abort without consuming model tool waits", () => {
    const elicitation = { resolve: vi.fn() };
    const tool = { resolve: vi.fn() };
    const pendingToolResults = new Map([
      ["mcpjam:elicitation:request", elicitation],
      ["model-tool", tool],
    ]);
    const turnAbort = new AbortController();
    runInNewContext(`(() => { ${abortSource} })()`, {
      pendingToolResults,
      turnAbort,
    });
    expect(turnAbort.signal.aborted).toBe(true);
    expect(elicitation.resolve).toHaveBeenCalledExactlyOnceWith({
      output: { action: "cancel" },
    });
    expect(tool.resolve).not.toHaveBeenCalled();
    expect([...pendingToolResults.keys()]).toEqual(["model-tool"]);
  });
});
