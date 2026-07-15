import { useEffect, useState } from "react";
import {
  buildParametersFromFields,
  generateFormFieldsFromSchema,
  type FormField,
} from "@/lib/tool-form";
import { buildHarnessToolPrompt } from "@/lib/harness-tool-prompt";
import { useAgentToolPromptBridge } from "@/stores/agent-tool-prompt-bridge";
import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";

/**
 * Selection + parameter state for harness built-in tools, so they flow through
 * the SAME select → detail → Run UX as server tools. "Run" doesn't execute (no
 * API can fire a built-in tool directly) — it asks the agent via a structured
 * prompt on the shared bridge, which `PlaygroundMain` sends as a normal turn.
 *
 * Shared by both Tools-panel surfaces (zero-server `PlaygroundLeft` and
 * active-server `MultiServerToolsPaneInner`).
 */
export function useBuiltinToolRun(builtinTools: HarnessBuiltinToolInfo[]) {
  const requestRun = useAgentToolPromptBridge((s) => s.requestRun);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected =
    builtinTools.find((t) => t.key === selectedKey) ?? null;
  const [fields, setFields] = useState<FormField[]>([]);

  // Regenerate the form when the selected built-in changes.
  useEffect(() => {
    const tool = builtinTools.find((t) => t.key === selectedKey);
    setFields(
      tool ? generateFormFieldsFromSchema(tool.inputSchema ?? {}) : [],
    );
    // builtinTools is reference-stable per harness (cached upstream); regen is
    // intentionally keyed on the selection only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  const onFieldChange = (name: string, value: unknown) =>
    setFields((cur) =>
      cur.map((f) => (f.name === name ? { ...f, value, isSet: true } : f)),
    );
  const onToggleField = (name: string, isSet: boolean) =>
    setFields((cur) => cur.map((f) => (f.name === name ? { ...f, isSet } : f)));

  const askAgentToRun = () => {
    if (!selected) return;
    const args = buildParametersFromFields(fields);
    requestRun(buildHarnessToolPrompt(selected.name, args));
  };

  return {
    selectedKey,
    selected,
    fields,
    select: (key: string) => setSelectedKey(key),
    clear: () => setSelectedKey(null),
    onFieldChange,
    onToggleField,
    askAgentToRun,
  };
}
