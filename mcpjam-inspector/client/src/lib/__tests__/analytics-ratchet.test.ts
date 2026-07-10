import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import { fileURLToPath } from "url";

/**
 * Ratchet fence for raw PostHog captures.
 *
 * All NEW analytics calls must go through `client/src/lib/analytics.ts#track`
 * (typed against shared/analytics-events.ts). The legacy raw
 * `posthog.capture(...)` call sites below are frozen: they may be migrated
 * (remove the file from the list when its last raw capture goes), but no new
 * file may add a raw capture.
 *
 * If this test fails because you added `posthog.capture(...)` in a new file:
 * register the event in shared/analytics-events.ts and call track() instead.
 * If it fails because you migrated a file: delete that file's entry from
 * LEGACY_RAW_CAPTURE_FILES — thanks for shrinking the list.
 */

const CLIENT_SRC = resolve(fileURLToPath(import.meta.url), "../../..");

const RAW_CAPTURE_PATTERN =
  /\bposthog(\?)?\.capture\(|\bposthogRef\.current(\?)?\.capture\(/;

// The one legitimate raw-capture site.
const ALLOWED_FILES = new Set(["lib/analytics.ts"]);

const LEGACY_RAW_CAPTURE_FILES = new Set([
  "App.tsx",
  "components/ActiveServerSelector.tsx",
  "components/auth/auth-upper-area.tsx",
  "components/billing/BillingUpsellGate.tsx",
  "components/billing/PaymentsHistorySection.tsx",
  "components/chat-v2/chat-input.tsx",
  "components/chat-v2/chat-input/model-selector.tsx",
  "components/chat-v2/chat-input/skills/skill-upload-dialog.tsx",
  "components/chat-v2/chat-input/skills/skills-popover-section.tsx",
  "components/chat-v2/thread/parts/tool-part.tsx",
  "components/chatboxes/GenerateSessionsDialog.tsx",
  "components/ChatTabV2.tsx",
  "components/compat/HostCompatContent.tsx",
  "components/computer/ComputerView.tsx",
  "components/computer/useComputerTerminal.ts",
  "components/connection/AddServerModal.tsx",
  "components/connection/JsonImportModal.tsx",
  "components/connection/ServerConnectionCard.tsx",
  "components/connection/ServerDetailModal.tsx",
  "components/evals/cross-host/cross-host-dashboard.tsx",
  "components/evals/eval-export-modal.tsx",
  "components/evals/eval-runner.tsx",
  "components/evals/evals-suite-list-sidebar.tsx",
  "components/evals/suite-header.tsx",
  "components/evals/suite-insights-collapsible.tsx",
  "components/evals/test-cases-overview.tsx",
  "components/evals/test-template-editor.tsx",
  "components/evals/TestCaseListSidebar.tsx",
  "components/evals/trace-raw-view.tsx",
  "components/evals/trace-timeline.tsx",
  "components/evals/trace-view-mode-tabs.tsx",
  "components/evals/use-eval-handlers.ts",
  "components/EvalsTab.tsx",
  "components/HomeTab.tsx",
  "components/hosted/ChatboxChatPage.tsx",
  "components/hosts/CreateHostDialog.tsx",
  "components/hosts/HostOverlayBar.tsx",
  "components/hosts/HostPicker.tsx",
  "components/hosts/MultiHostPicker.tsx",
  "components/hosts/redesigned/HostBuilderViewRedesigned.tsx",
  "components/logger-view.tsx",
  "components/mcp-sidebar.tsx",
  "components/mcpjam-agent/AgentSidePanel.tsx",
  "components/mcpjam-agent/AgentSidePanelMount.tsx",
  "components/mcpjam-agent/AgentSidePanelTrigger.tsx",
  "components/mcpjam-agent/McpjamAgentHero.tsx",
  "components/OAuthFlowTab.tsx",
  "components/playground/PlaygroundLeftRail.tsx",
  "components/playground/PlaygroundRightRail.tsx",
  "components/playground/PlaygroundTab.tsx",
  "components/project/ProjectMembersFacepile.tsx",
  "components/project/ProjectShareButton.tsx",
  "components/project/ShareProjectDialog.tsx",
  "components/ServersTab.tsx",
  "components/setting/ProviderConfigDialog.tsx",
  "components/SettingsTab.tsx",
  "components/shared/ClientContextHeader.tsx",
  "components/signup/OccupationGate.tsx",
  "components/tools/ParametersPanel.tsx",
  "components/tools/SavedRequestItem.tsx",
  "components/tools/ToolsSidebar.tsx",
  "components/ToolsTab.tsx",
  "components/ui-playground/hooks/use-playground-state.ts",
  "components/ui-playground/hooks/useToolExecution.ts",
  "components/ui-playground/PlaygroundMain.tsx",
  "components/ui-playground/TabHeader.tsx",
  "components/xaa/registration/XAARegistrationWizard.tsx",
  "components/xaa/XAAFlowTab.tsx",
  "hooks/use-chat.ts",
  "hooks/use-mcpjam-agent-session.ts",
  "hooks/use-onboarding.ts",
  "hooks/use-server-state.ts",
  "hooks/useCreditTopup.ts",
  "hooks/useCreditTopupReturnFlow.ts",
  "lib/evals/excalidraw-quickstart.ts",
  "lib/host-compat/use-host-catalog.ts",
  "lib/mcpjam-agent/agent-chat-instances.ts",
  "lib/session-token.ts",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__")
        continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("analytics ratchet", () => {
  const offenders = sourceFiles(CLIENT_SRC)
    .filter((file) => RAW_CAPTURE_PATTERN.test(readFileSync(file, "utf8")))
    .map((file) => relative(CLIENT_SRC, file))
    .filter((file) => !ALLOWED_FILES.has(file));

  it("no NEW files call posthog.capture directly — use lib/analytics.ts track()", () => {
    const newOffenders = offenders.filter(
      (file) => !LEGACY_RAW_CAPTURE_FILES.has(file),
    );
    expect(newOffenders).toEqual([]);
  });

  it("migrated files are removed from the legacy list", () => {
    const current = new Set(offenders);
    const stale = [...LEGACY_RAW_CAPTURE_FILES].filter(
      (file) => !current.has(file),
    );
    expect(stale).toEqual([]);
  });
});
