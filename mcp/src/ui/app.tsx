/**
 * The single MCP Apps bundle shared by every widget-backed MCPJam tool. The
 * worker tags each tool's structured content with `widget: <view>`
 * (`../shared/platform-widgets.ts`) and this root routes the result to the
 * matching view. Untagged show-servers payloads still render, as a safety
 * net for the original widget contract.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import { ServersLoadingSkeleton } from "@mcpjam/design-system/servers-loading-skeleton";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  getPlatformWidgetView,
  type PlatformWidgetPayloadMap,
} from "../shared/platform-widgets.js";
import {
  getResultErrorCode,
  getResultText,
  MessageBox,
  Shell,
  useMcpAppHost,
} from "./shared/app-shell.js";
import { ChatboxesView, ChatboxView } from "./views/chatboxes.js";
import {
  EvalRunIterationsView,
  EvalRunView,
  EvalSuiteRunsView,
  EvalSuitesView,
} from "./views/evals.js";
import { isShowServersPayload, ServersView } from "./views/servers.js";
import "./global.css";

const APP_INFO = {
  name: "MCPJam platform",
  version: "1.0.0",
};

function McpJamPlatformApp() {
  const { app, error, toolResult, hostContext, isDark, themePreset } =
    useMcpAppHost(APP_INFO);

  let content: ReactNode;
  if (error) {
    content = (
      <MessageBox
        label="App error"
        message={error.message}
        variant="destructive"
      />
    );
  } else if (!app) {
    content = (
      <MessageBox label="Connecting" message="Waiting for MCPJam data." />
    );
  } else {
    content = (
      <WidgetContent app={app} toolResult={toolResult} isDark={isDark} />
    );
  }

  return (
    <Shell hostContext={hostContext} isDark={isDark} themePreset={themePreset}>
      {content}
    </Shell>
  );
}

function WidgetContent({
  app,
  isDark,
  toolResult,
}: {
  app: App;
  isDark: boolean;
  toolResult: CallToolResult | null;
}) {
  if (!toolResult) {
    return (
      <ServersLoadingSkeleton className="p-0" data-testid="mcpjam-app-loading" />
    );
  }

  if (toolResult.isError) {
    const message = getResultText(toolResult) ?? "The tool returned an error.";
    // A NOT_FOUND result (no accessible projects, or a selector that matched
    // nothing — e.g. an anonymous guest connection) is an empty state, not a
    // failure. Render it calmly instead of as a destructive error.
    if (getResultErrorCode(toolResult) === "NOT_FOUND") {
      return <MessageBox label="Nothing to show yet" message={message} />;
    }
    return (
      <MessageBox
        label="Unable to load data"
        message={message}
        variant="destructive"
      />
    );
  }

  const payload = toolResult.structuredContent;
  const view = getPlatformWidgetView(payload);

  switch (view) {
    case "servers":
      return (
        <ServersView
          payload={payload as PlatformWidgetPayloadMap["servers"]}
          isDark={isDark}
        />
      );
    case "eval_suites":
      return (
        <EvalSuitesView
          payload={payload as PlatformWidgetPayloadMap["eval_suites"]}
          isDark={isDark}
        />
      );
    case "eval_suite_runs":
      return (
        <EvalSuiteRunsView
          payload={payload as PlatformWidgetPayloadMap["eval_suite_runs"]}
          isDark={isDark}
        />
      );
    case "eval_run":
      return (
        <EvalRunView
          payload={payload as PlatformWidgetPayloadMap["eval_run"]}
          isDark={isDark}
        />
      );
    case "eval_run_iterations":
      return (
        <EvalRunIterationsView
          payload={payload as PlatformWidgetPayloadMap["eval_run_iterations"]}
          isDark={isDark}
        />
      );
    case "chatboxes":
      return (
        <ChatboxesView
          app={app}
          payload={payload as PlatformWidgetPayloadMap["chatboxes"]}
          isDark={isDark}
        />
      );
    case "chatbox":
      return (
        <ChatboxView
          app={app}
          payload={payload as PlatformWidgetPayloadMap["chatbox"]}
          isDark={isDark}
        />
      );
    case undefined:
      if (isShowServersPayload(payload)) {
        return <ServersView payload={payload} isDark={isDark} />;
      }
      return (
        <MessageBox
          label="Missing structured content"
          message="The tool result did not include a recognized MCPJam payload."
          variant="destructive"
        />
      );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <McpJamPlatformApp />
  </StrictMode>
);
