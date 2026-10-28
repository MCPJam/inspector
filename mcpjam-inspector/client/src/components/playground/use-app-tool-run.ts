import { useEffect, useRef, useState } from "react";
import {
  dispatchAppToolCall,
  recordAppToolInvocation,
  useAppToolsRegistryApi,
} from "@mcpjam/widget-react";
import { stableStringifyJson } from "@mcpjam/sdk/widget-runtime";
import {
  buildParametersFromFields,
  generateFormFieldsFromSchema,
  type FormField,
} from "@/lib/tool-form";
import { track } from "@/lib/analytics";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import { usePlaygroundChatHistoryBridgeStore } from "./playground-chat-history-bridge";
import { useAppPaneTools } from "./use-app-pane-tools";
import type { AppPaneTool } from "./app-pane-tools";
import { APP_CLOSED_MESSAGE, appToolResult } from "./app-tool-result";

function schemaFingerprint(tool: AppPaneTool | null) {
  try {
    return stableStringifyJson(tool?.inputSchema ?? {});
  } catch {
    return tool?.inputSchema;
  }
}

export function useAppToolRun() {
  const groups = useAppPaneTools();
  const registry = useAppToolsRegistryApi();
  const sessionId = useActiveChatSessionStore((state) => state.sessionId);
  const viewOnly = useActiveChatSessionStore((state) => state.viewOnly);
  const streaming = usePlaygroundChatHistoryBridgeStore(
    (state) => state.bridge?.isStreaming ?? false,
  );
  const [selection, setSelection] = useState<{
    tool: AppPaneTool;
    sessionId: string | null;
  } | null>(null);
  const catalog = groups.flatMap((group) => group.tools);
  const retained = useRef<AppPaneTool | null>(null);
  const live = catalog.find((tool) => tool.key === selection?.tool.key);
  if (live) retained.current = live;
  const selected =
    selection?.sessionId === sessionId
      ? (live ??
        (retained.current?.key === selection.tool.key
          ? retained.current
          : selection.tool))
      : null;
  const available =
    !!selected && catalog.some((tool) => tool.key === selected.key);
  const [fields, setFields] = useState<FormField[]>([]);
  const [invoking, setInvoking] = useState(false);
  const [result, setResult] = useState<ReturnType<typeof appToolResult> | null>(
    null,
  );
  const token = useRef(0);
  const busy = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const current = useRef({ sessionId, key: selected?.key });
  current.current = { sessionId, key: selected?.key };
  const fingerprint = schemaFingerprint(selected);
  const schema = useRef(selected?.inputSchema);
  schema.current = selected?.inputSchema;

  useEffect(() => {
    setFields((previous) =>
      generateFormFieldsFromSchema(schema.current ?? {}).map((field) => {
        const old = previous.find(
          (item) => item.name === field.name && item.type === field.type,
        );
        return old ? { ...field, value: old.value, isSet: old.isSet } : field;
      }),
    );
    setResult(null);
    token.current += 1;
    busy.current = false;
    setInvoking(false);
  }, [selected?.key, fingerprint]);

  useEffect(() => {
    setSelection(null);
    setResult(null);
    setInvoking(false);
    busy.current = false;
    token.current += 1;
    const pending = controllers.current;
    return () => {
      for (const controller of pending) controller.abort();
    };
  }, [sessionId]);

  const clear = () => {
    token.current += 1;
    busy.current = false;
    setSelection(null);
    setInvoking(false);
    setResult(null);
    setFields([]);
  };
  const select = (key: string) => {
    const tool = catalog.find((tool) => tool.key === key);
    if (!tool) return;
    clear();
    setSelection({ tool, sessionId });
  };
  const canRun = available && !streaming && !viewOnly && !invoking;
  const run = async () => {
    if (!selected || !canRun || busy.current || !sessionId) return;
    const state = registry.getState();
    // Resolve against the active bridge at click time, including modal swaps.
    const bridgeId = state.activeBridgeByParent.get(
      `${sessionId}\0${selected.instance.parentToolCallId}`,
    );
    const alias = [...state.aliases.values()].find(
      (entry) =>
        entry.bridgeId === bridgeId && entry.rawName === selected.rawName,
    )?.alias;
    const entry = alias ? state.resolve(alias, sessionId) : null;
    if (!entry || !alias) return;
    const runId = ++token.current;
    const key = selected.key;
    const isCurrent = () =>
      token.current === runId &&
      current.current.sessionId === sessionId &&
      current.current.key === key;
    const controller = new AbortController();
    controllers.current.add(controller);
    busy.current = true;
    setInvoking(true);
    setResult(null);
    state.registerPendingCall(entry.instance.bridgeId, controller);
    const input = buildParametersFromFields(fields);
    let success = false;
    try {
      entry.instance
        .getIframeElement?.()
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      const raw = await dispatchAppToolCall(entry, input, {
        signal: controller.signal,
      });
      recordAppToolInvocation(
        {
          alias,
          rawName: entry.rawName,
          appName: entry.instance.appName,
          serverId: entry.instance.serverId,
          parentToolCallId: entry.instance.parentToolCallId,
          bridgeId: entry.instance.bridgeId,
          input,
          raw,
          initiatedBy: "user",
        },
        useTrafficLogStore.getState().addLog,
      );
      success = !raw.isError;
      if (isCurrent()) setResult(appToolResult(raw));
    } catch (error) {
      if (isCurrent())
        setResult(
          appToolResult({
            isError: true,
            content: [
              {
                type: "text",
                text: controller.signal.aborted
                  ? APP_CLOSED_MESSAGE
                  : error instanceof Error
                    ? error.message
                    : String(error),
              },
            ],
          }),
        );
    } finally {
      state.unregisterPendingCall(entry.instance.bridgeId, controller);
      controllers.current.delete(controller);
      track("app_builder_tool_executed", {
        source: "app",
        location: "playground_tools_rail",
        toolName: entry.rawName,
        success,
      });
      if (isCurrent()) {
        busy.current = false;
        setInvoking(false);
      }
    }
  };
  return {
    groups,
    selected,
    selectedKey: selected?.key ?? null,
    fields,
    invoking,
    result,
    select,
    clear,
    run,
    canRun,
    detailProps: selected
      ? {
          tool: {
            key: selected.key,
            name: selected.rawName,
            description: selected.description,
            inputSchema: selected.inputSchema,
          },
          fields,
          onFieldChange: (name: string, value: unknown) =>
            setFields((current) =>
              current.map((field) =>
                field.name === name ? { ...field, value, isSet: true } : field,
              ),
            ),
          onToggleField: (name: string, isSet: boolean) =>
            setFields((current) =>
              current.map((field) =>
                field.name === name ? { ...field, isSet } : field,
              ),
            ),
          headerDescription: `From ${selected.instance.appName} (${selected.instance.serverId})`,
          runHint: "calls this tool in the app now. The model isn't told.",
          status: !available
            ? "This tool's app closed."
            : streaming
              ? "Wait for the reply to finish."
              : viewOnly
                ? "This session only allows viewing."
                : undefined,
          result,
        }
      : null,
  };
}
