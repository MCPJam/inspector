/**
 * Selection + parameter state for the agent browser's tools (the six
 * `browser_*` verbs and the page's `webmcp_*` ones), so they flow through the
 * SAME select → detail → Run UX as server tools.
 *
 * Page-tool Run invokes the page directly — a person clicking Run on a tool
 * they can see, on a page they opened, has already made the decision an
 * approval prompt would ask. `browser_*` still asks the agent: firing those
 * from this form would drive a signed-in Chromium outside the approval path.
 */
import { useEffect, useMemo, useState } from "react";
import {
  buildParametersFromFields,
  generateFormFieldsFromSchema,
  type FormField,
} from "@/lib/tool-form";
import { buildHarnessToolPrompt } from "@/lib/harness-tool-prompt";
import { useAgentToolPromptBridge } from "@/stores/agent-tool-prompt-bridge";
import type {
  BrowserPageToolInvokeResponse,
  BrowserPageToolsResponse,
} from "@/shared/browser-page-tools";
import type { SerializedModelRequestTool } from "@/shared/model-request-payload";
import {
  catalogBrowserPaneTools,
  type BrowserPaneTool,
} from "./browser-pane-tools";

export type PageToolInvokeFn = (args: {
  rawName: string;
  frameId?: string;
  input: Record<string, unknown>;
}) => Promise<BrowserPageToolInvokeResponse>;

export type BrowserToolRunResult = { ok: boolean; text: string };

function resultText(answer: BrowserPageToolInvokeResponse): string {
  if (answer.ok) {
    if (answer.output === undefined) return "ok";
    if (typeof answer.output === "string") return answer.output;
    try {
      return JSON.stringify(answer.output, null, 2);
    } catch {
      return String(answer.output);
    }
  }
  return answer.detail ? `${answer.error}: ${answer.detail}` : answer.error;
}

export function useBrowserToolRun(
  tools: SerializedModelRequestTool[],
  page: BrowserPageToolsResponse | null,
  invokePage?: PageToolInvokeFn,
) {
  const requestRun = useAgentToolPromptBridge((s) => s.requestRun);
  const catalog = useMemo(
    () => catalogBrowserPaneTools({ tools, page }),
    [tools, page],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = catalog.find((t) => t.key === selectedKey) ?? null;
  const [fields, setFields] = useState<FormField[]>([]);
  const [invoking, setInvoking] = useState(false);
  const [result, setResult] = useState<BrowserToolRunResult | null>(null);

  useEffect(() => {
    const tool = catalog.find((t) => t.key === selectedKey);
    setFields(tool ? generateFormFieldsFromSchema(tool.inputSchema ?? {}) : []);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // A navigation can retire the selected page tool. Drop the selection rather
  // than leaving a form up for a name the model no longer has.
  useEffect(() => {
    if (selectedKey && !catalog.some((t) => t.key === selectedKey)) {
      setSelectedKey(null);
    }
  }, [catalog, selectedKey]);

  const onFieldChange = (name: string, value: unknown) =>
    setFields((cur) =>
      cur.map((f) => (f.name === name ? { ...f, value, isSet: true } : f)),
    );
  const onToggleField = (name: string, isSet: boolean) =>
    setFields((cur) => cur.map((f) => (f.name === name ? { ...f, isSet } : f)));

  const askAgentToRun = () => {
    if (!selected || selected.blocking) return;
    const argsForCall = buildParametersFromFields(fields);
    requestRun(buildHarnessToolPrompt(selected.callName, argsForCall));
  };

  const run = async () => {
    if (!selected || selected.blocking || invoking) return;
    if (selected.kind === "page" && invokePage) {
      setInvoking(true);
      setResult(null);
      try {
        const answer = await invokePage({
          rawName: selected.title,
          ...(selected.frameId ? { frameId: selected.frameId } : {}),
          input: buildParametersFromFields(fields),
        });
        setResult({ ok: answer.ok, text: resultText(answer) });
      } catch {
        setResult({ ok: false, text: "unreachable" });
      } finally {
        setInvoking(false);
      }
      return;
    }
    askAgentToRun();
  };

  return {
    catalog,
    selectedKey,
    selected,
    fields,
    select: (key: string) => setSelectedKey(key),
    clear: () => setSelectedKey(null),
    onFieldChange,
    onToggleField,
    askAgentToRun,
    run,
    invoking,
    result,
    canRun: Boolean(selected && !selected.blocking && !invoking),
  };
}

export type { BrowserPaneTool };
