import { isToolPolicyBlockResult } from "@mcpjam/sdk/contract";
import {
  widgetCallToToolCall,
  mergeToolCallsByPromptIndex,
  type ToolCall,
} from "../../../shared/eval-matching.js";
import type { ViewToolCallRecord } from "../../utils/mcp-app-view-tools.js";
import { WIDGET_TOOL_VERBS } from "../widget-tool-verbs.js";

/** The trace retains verbs; assertions see only calls that reached a view. */
export function mergeViewToolEvidence(
  modelCalls: readonly ToolCall[][],
  records: ReadonlyArray<{ promptIndex: number; call: ViewToolCallRecord }>,
): ToolCall[][] {
  const actual = modelCalls.map((calls) =>
    calls.filter((call) => !WIDGET_TOOL_VERBS.includes(call.toolName)),
  );
  const viewCalls: ToolCall[][] = [];
  for (const { promptIndex, call } of records) {
    if (promptIndex < 0) continue;
    (viewCalls[promptIndex] ??= []).push(
      { toolName: call.rawName, arguments: call.arguments },
      ...call.widgetToolCalls
        .filter((child) => !isToolPolicyBlockResult(child.result))
        .map(widgetCallToToolCall),
    );
  }
  return mergeToolCallsByPromptIndex(actual, viewCalls);
}

/** Only new dispatches belong to this step, even when a follow-up shares a turn. */
export function viewToolEvidenceForStep(
  calls: ToolCall[],
  records: ReadonlyArray<{ promptIndex: number; call: ViewToolCallRecord }>,
): ToolCall[] {
  return (
    mergeViewToolEvidence(
      [calls],
      records.map((entry) => ({ ...entry, promptIndex: 0 })),
    )[0] ?? []
  );
}
