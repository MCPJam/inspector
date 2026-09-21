import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import ts from "typescript";

/**
 * Ratchet fence for em dashes in user-facing copy.
 *
 * Product copy carries no em dashes. AI-written PRs reach for them, so today's
 * count is frozen per file below: a listed file may only shed them, and a file
 * that is not listed must have none.
 *
 * Only string literals, template literals and JSX text count. Comments are not
 * copy, and the AST never visits them. A literal that is exactly "—" is the
 * empty-value placeholder tables render to mean "no value", so a standalone one
 * is exempt. One sitting next to an interpolation is a separator inside a real
 * sentence, not a placeholder, so it counts.
 *
 * Failing because you wrote a new one? Rewrite the sentence; a comma, a colon
 * or a full stop almost always does the job. Failing because you cleaned a file
 * up? Lower its number here, or drop the entry once it reaches zero.
 */

const CLIENT_SRC = resolve(fileURLToPath(import.meta.url), "../../..");

const EM_DASH = "—";

// JSX decodes these to an em dash, and the AST hands back raw source text.
const EM_DASH_ENTITY = /&(?:mdash|#0*8212|#x0*2014);/gi;

// Fixtures and generated output are not product copy.
const SKIPPED_ROOTS = ["test/", "generated/"];

const LEGACY_EM_DASH_COPY = new Map<string, number>([
  ["App.tsx", 1],
  ["components/auth/GuestSignInMessage.tsx", 1],
  ["components/billing/CreditBalanceCard.tsx", 1],
  ["components/billing/PendingCreditTopupsBanner.tsx", 1],
  ["components/browser/BrowserActivityList.tsx", 3],
  ["components/browser/BrowserStartPage.tsx", 1],
  ["components/browser/LocalBrowserBody.tsx", 1],
  ["components/chat-v2/chat-input.tsx", 1],
  ["components/chat-v2/chat-input/execution-target-chip.tsx", 3],
  ["components/chat-v2/chat-input/skills/skill-upload-dialog.tsx", 1],
  ["components/chat-v2/chat-input/skills/skills-popover-section.tsx", 1],
  ["components/chat-v2/history/convert-session-dialog-core.tsx", 1],
  ["components/chat-v2/shared/save-as-test-case-action.tsx", 2],
  ["components/chat-v2/thread/csp-workbench/BlockedRequestCard.tsx", 3],
  ["components/chat-v2/thread/csp-workbench/classify.ts", 2],
  ["components/chat-v2/thread/csp-workbench/OriginCard.tsx", 3],
  ["components/chat-v2/thread/part-switch.tsx", 1],
  ["components/chat-v2/thread/parts/ask-user-part.tsx", 2],
  ["components/CiEvalsTab.tsx", 1],
  ["components/client-config/ClientConfigEditor.tsx", 8],
  ["components/compat/HostCompatPage.tsx", 1],
  ["components/computer/BrowserPanel.tsx", 2],
  ["components/computer/ComputersUnavailableMessage.tsx", 1],
  ["components/computer/ComputerTerminal.tsx", 1],
  ["components/computer/ComputerView.tsx", 8],
  ["components/computer/LocalComputerConsentGate.tsx", 1],
  ["components/computer/LocalComputerView.tsx", 2],
  ["components/computer/SandboxImagesDrawer.tsx", 2],
  ["components/conformance/ConformancePanel.tsx", 2],
  [
    "components/conformance/directory-readiness/DirectoryReadinessSection.tsx",
    4,
  ],
  ["components/conformance/directory-readiness/ObservationNotice.tsx", 2],
  ["components/conformance/directory-readiness/readiness-copy.ts", 5],
  ["components/conformance/ScoreHeadline.tsx", 1],
  ["components/connection/ServerConnectionCard.tsx", 2],
  ["components/connection/ServerInfoContent.tsx", 1],
  ["components/connection/share-usage/ShareUsageDialog.tsx", 1],
  ["components/connection/share-usage/ShareUsageThreadDetail.tsx", 2],
  ["components/connection/shared/AuthenticationSection.tsx", 3],
  ["components/connection/shared/XaaCredentialFields.tsx", 1],
  ["components/connection/TunnelExplanationModal.tsx", 1],
  ["components/elicitation/UrlElicitationConsent.tsx", 1],
  ["components/environment-composer/environment-composer.tsx", 4],
  ["components/environment-composer/resolve-stacks.ts", 1],
  ["components/evals/ai-triage-card.tsx", 4],
  ["components/evals/ai-triage-helpers.ts", 2],
  ["components/evals/auto-fix-status-sentence.ts", 1],
  ["components/evals/browser-artifacts-view.tsx", 2],
  ["components/evals/browser-step-replay.tsx", 5],
  ["components/evals/case-pass-criteria-section.tsx", 2],
  ["components/evals/case-upsert-toast.ts", 1],
  ["components/evals/checks-section.tsx", 11],
  ["components/evals/cross-host/host-cell.tsx", 1],
  ["components/evals/explore-cases-list.tsx", 1],
  ["components/evals/export-traces-modal.tsx", 1],
  ["components/evals/goal-completion-card.tsx", 2],
  ["components/evals/goal-completion-presentation.tsx", 5],
  ["components/evals/harness-system-tools.ts", 1],
  ["components/evals/helpers.ts", 2],
  ["components/evals/import-evidence-card.tsx", 1],
  ["components/evals/judge-gate-panel.tsx", 1],
  ["components/evals/judge-rubric-editor.tsx", 2],
  ["components/evals/judges-section.tsx", 2],
  ["components/evals/live-trace-raw-empty.tsx", 1],
  ["components/evals/live-trace-timeline-empty.tsx", 1],
  ["components/evals/monitoring-tab.tsx", 3],
  ["components/evals/pinned-render-check-card.tsx", 1],
  ["components/evals/preview/expected-conversation.tsx", 1],
  ["components/evals/render-preview-panel.tsx", 2],
  ["components/evals/run-decision-summary-card.tsx", 1],
  ["components/evals/run-disclosure-hint.tsx", 8],
  ["components/evals/run-group-diagnosis-presentation.tsx", 1],
  ["components/evals/run-insights-sidebar.tsx", 3],
  ["components/evals/run-metadata-display.tsx", 1],
  ["components/evals/run-overview.tsx", 1],
  ["components/evals/run-user-value-chain-slot.tsx", 2],
  ["components/evals/runs/case-runs-history.tsx", 1],
  ["components/evals/runs/replayed-scenario-pane.tsx", 1],
  ["components/evals/schedule-editor.tsx", 4],
  ["components/evals/scores-list.tsx", 1],
  ["components/evals/sdk-eval-quickstart.tsx", 7],
  ["components/evals/suite-automation-row.tsx", 1],
  ["components/evals/suite-environment-composer-bar.tsx", 2],
  ["components/evals/suite-grading-model.ts", 2],
  ["components/evals/suite-group-compare.tsx", 1],
  ["components/evals/suite-header.tsx", 1],
  ["components/evals/suite-hero-stats.tsx", 1],
  ["components/evals/suite-iterations-view.tsx", 2],
  ["components/evals/suite-runs-chart-grid.tsx", 1],
  ["components/evals/suite-scorer-table.tsx", 1],
  ["components/evals/suite-stage-facts-panel.tsx", 1],
  ["components/evals/suite-stage-facts.ts", 7],
  ["components/evals/test-cases-overview.tsx", 1],
  ["components/evals/test-template-editor.tsx", 4],
  ["components/evals/TestCaseListSidebar.tsx", 1],
  ["components/evals/trace-raw-view.tsx", 1],
  ["components/evals/trace-view-mode-tabs.tsx", 1],
  ["components/evals/trial-judge-review.tsx", 3],
  ["components/evals/use-eval-handlers.ts", 1],
  ["components/evals/use-suite-settings-draft.ts", 1],
  ["components/EvalsTab.tsx", 10],
  ["components/evaluate/case-scorecard/case-scorecard-model.ts", 5],
  ["components/evaluate/case-scorecard/case-scorecard.tsx", 1],
  ["components/evaluate/case-scorecard/judge-answer-row.tsx", 2],
  ["components/evaluate/case-scorecard/judge-block.tsx", 1],
  ["components/evaluate/case-scorecard/next-question.ts", 1],
  ["components/evaluate/case-scorecard/route-row.tsx", 1],
  ["components/evaluate/case-scorecard/row-marker.tsx", 2],
  ["components/evaluate/case-scorecard/suggest-from-run.ts", 1],
  ["components/evaluate/case-scorecard/suggested-from-run-card.tsx", 4],
  ["components/evaluate/case-scorecard/trial-scorecard-row.tsx", 2],
  ["components/evaluate/case-spine/after-the-run.tsx", 1],
  ["components/evaluate/route-facts-model.ts", 1],
  ["components/evaluate/run-case-rows.tsx", 1],
  ["components/evaluate/server-facts-card.tsx", 1],
  ["components/evaluate/server-facts-model.ts", 2],
  ["components/EvaluateTab.tsx", 1],
  ["components/harness/LocalHarnessComposerNotice.tsx", 1],
  ["components/harness/LocalHarnessTrustDialog.tsx", 3],
  ["components/home/SharedSlackChannelCard.tsx", 1],
  ["components/hosted/ScenarioTaskChecklist.tsx", 1],
  ["components/hosts/comparison/support-level.ts", 1],
  ["components/hosts/redesigned/canvas/HostCapabilityMatrix.tsx", 4],
  ["components/hosts/redesigned/focus/BrowserProfilePicker.tsx", 1],
  ["components/hosts/redesigned/focus/ComputerTab.tsx", 1],
  ["components/hosts/redesigned/focus/GeneralTab.tsx", 1],
  ["components/hosts/redesigned/focus/HostStyleTokens.tsx", 2],
  ["components/hosts/redesigned/focus/ProtocolTab.tsx", 7],
  ["components/hosts/redesigned/focus/useHostDraftValidation.ts", 3],
  ["components/hosts/redesigned/HostBuilderViewRedesigned.tsx", 1],
  ["components/HostsTab.tsx", 3],
  ["components/lifecycle/guided-tour-lessons.ts", 20],
  ["components/lifecycle/mcp-lifecycle-guide-data.ts", 2],
  ["components/logger-view.tsx", 2],
  ["components/mcpjam-agent/McpjamAgentThread.tsx", 1],
  ["components/OAuthFlowTab.tsx", 7],
  ["components/organization/observability/presets.ts", 1],
  ["components/organization/observability/TraceDestinationDialog.tsx", 5],
  ["components/organization/observability/TraceDestinationsSection.tsx", 4],
  ["components/organization/OrganizationCurrentPlanPanel.tsx", 1],
  ["components/organization/surface/SurfaceActivityTab.tsx", 2],
  ["components/organization/surface/SurfaceConnectionsTab.tsx", 1],
  ["components/playground/BrowserToolsSection.tsx", 1],
  ["components/playground/BuiltinToolDetailView.tsx", 1],
  ["components/playground/ConversationTargetNotice.tsx", 1],
  ["components/playground/HarnessBuiltinToolsSection.tsx", 2],
  ["components/playground/panes/EnvironmentToolsPane.tsx", 2],
  ["components/playground/panes/MultiServerToolsPane.tsx", 2],
  ["components/playground/PlaygroundEnvironmentSection.tsx", 1],
  ["components/playground/PlaygroundPluginSelector.tsx", 1],
  ["components/plugins/plugin-presentation.ts", 1],
  ["components/plugins/PluginImportPreviewContent.tsx", 3],
  ["components/project-environments/environment-picker.tsx", 1],
  ["components/project-environments/EnvironmentCanvasPanel.tsx", 1],
  ["components/project-environments/EnvironmentSummaryLine.tsx", 1],
  ["components/project-environments/NameEnvironmentDialog.tsx", 2],
  ["components/project-environments/ProjectEnvironmentEditor.tsx", 4],
  ["components/project-environments/ProjectEnvironmentSecretsPicker.tsx", 3],
  ["components/project-environments/ProjectEnvironmentSkillsPicker.tsx", 3],
  ["components/project-environments/ProjectEnvironmentsRoute.tsx", 3],
  ["components/project/ProjectSecretsSection.tsx", 5],
  ["components/PromptsTab.tsx", 4],
  ["components/registry/DirectoryDetailDialog.tsx", 1],
  ["components/registry/OrgRegistryRemoveDialog.tsx", 1],
  ["components/registry/OrgRegistryServerDialog.tsx", 1],
  ["components/RegistryTab.tsx", 7],
  ["components/ResourcesTab.tsx", 4],
  ["components/scenarios/findings/scenario-findings-derivation.ts", 2],
  ["components/scenarios/findings/scenario-findings-tab.tsx", 1],
  ["components/scenarios/ScenarioOutcomeCalibration.tsx", 2],
  ["components/scenarios/ScenarioPreviewPane.tsx", 2],
  ["components/scenarios/ScenarioShareEmptyPanel.tsx", 3],
  ["components/scenarios/ScenarioShareSection.tsx", 1],
  ["components/scenarios/ScenarioTasksSection.tsx", 3],
  ["components/scenarios/session-readiness.tsx", 3],
  ["components/scenarios/UserTestingOverviewPanel.tsx", 1],
  ["components/scenarios/UserTestingScenarioCreateFlow.tsx", 2],
  ["components/scenarios/UserTestingScenarioDetail.tsx", 3],
  ["components/score/bench-cleanup-message.ts", 1],
  ["components/score/BenchCategorySelector.tsx", 2],
  ["components/score/BenchQuoteScreen.tsx", 4],
  ["components/score/BenchResultsPage.tsx", 1],
  ["components/score/BenchRunnerPage.tsx", 1],
  ["components/score/BenchRunProgress.tsx", 1],
  ["components/score/ScoreResultsPage.tsx", 3],
  ["components/score/ScoreSuiteBreakdown.tsx", 2],
  ["components/server-connections/ServerConnectionHandoff.tsx", 2],
  ["components/ServersAutoConnectSwitch.tsx", 1],
  ["components/settings/github-pr-server-oauth-control.tsx", 1],
  ["components/settings/GithubChecksRoute.tsx", 5],
  ["components/settings/IntegrationsRoute.tsx", 1],
  ["components/shared/actionable-insights/actionable-findings-panel.tsx", 1],
  ["components/shared/actionable-insights/finding-prompts.ts", 7],
  ["components/shared/session-quality/judge-presentation.tsx", 1],
  ["components/shared/session-quality/session-goal-score-badge.tsx", 1],
  ["components/shared/usage-insights/SessionFlowSankey.tsx", 3],
  ["components/shared/user-value-chain/SessionUserValueChain.tsx", 2],
  ["components/sharing/ShareSection.tsx", 3],
  ["components/sidebar/sidebar-trial-countdown.tsx", 1],
  ["components/skills/ServerSkillsSection.tsx", 2],
  ["components/subscriptions/subscription-stream-state.ts", 1],
  ["components/subscriptions/SubscriptionStreamsPanel.tsx", 1],
  ["components/swarms/findings/findings-derivation-legacy.ts", 1],
  ["components/swarms/findings/findings-headline.ts", 4],
  ["components/swarms/journey-list.tsx", 3],
  ["components/swarms/journey-run-results.tsx", 2],
  ["components/swarms/new-swarm-confirm-step.tsx", 2],
  ["components/swarms/new-swarm-create-flow.tsx", 4],
  ["components/swarms/new-swarm-running-step.tsx", 2],
  ["components/swarms/run-scorecard.tsx", 1],
  ["components/swarms/swarm-run-detail.tsx", 3],
  ["components/swarms/swarm-target-composer.tsx", 4],
  ["components/swarms/SwarmsTab.tsx", 8],
  ["components/TasksTab.tsx", 4],
  ["components/tracing/HttpExchangeDetails.tsx", 2],
  ["components/ui-playground/hooks/useToolExecution.ts", 1],
  ["components/ui-playground/PlaygroundLeft.tsx", 2],
  ["components/ui/chart.tsx", 1],
  ["components/ui/error-card.tsx", 1],
  ["components/UserTestingTab.tsx", 4],
  ["components/webmcp-inspector/ToolsPanel.tsx", 4],
  ["components/webmcp-inspector/WebmcpInspectorTab.tsx", 7],
  ["components/what-is-mcp/what-is-mcp-guide-data.ts", 13],
  ["components/why-mcp/WhyMcpToolCallingDiagram.tsx", 1],
  ["components/xaa/NegativeTestScorecard.tsx", 2],
  ["components/xaa/XAADcrReRegisterControl.tsx", 1],
  ["components/xaa/XAAFlowLogger.tsx", 6],
  ["components/xaa/XAAFlowTab.tsx", 2],
  ["components/xaa/XAAPeopleStrip.tsx", 1],
  ["hooks/use-chat-session.ts", 5],
  ["hooks/use-run-cost-estimate.ts", 4],
  ["hooks/useCreditTopupReturnFlow.ts", 1],
  ["hooks/useServerDirectory.ts", 3],
  ["hooks/useXaaTestTarget.ts", 1],
  ["lib/apis/mcp-skills-api.ts", 2],
  ["lib/app-routes.ts", 3],
  ["lib/cloud-server-readiness.ts", 2],
  ["lib/computer-attachments.ts", 1],
  ["lib/evals/eval-export.ts", 1],
  ["lib/evals/excalidraw-quickstart.ts", 1],
  ["lib/evals/is-ci-owned-suite.ts", 1],
  ["lib/evals/openai-submission-report.ts", 4],
  ["lib/evals/run-origin.ts", 2],
  ["lib/generate-agent-brief.ts", 1],
  ["lib/learn-more-content.ts", 2],
  ["lib/oauth/mcp-oauth.ts", 3],
  ["lib/scenario-backing.ts", 1],
  ["lib/webmcp-inspector/chat-dispatch.ts", 1],
  ["lib/webmcp/groups/computer.ts", 4],
  ["lib/webmcp/groups/core.ts", 5],
  ["lib/webmcp/groups/evals.ts", 4],
  ["lib/webmcp/groups/hosts.ts", 5],
  ["lib/webmcp/groups/oauth-flow.ts", 3],
  ["lib/webmcp/groups/playground.ts", 3],
  ["lib/webmcp/groups/registry.ts", 3],
  ["lib/webmcp/groups/resources.ts", 1],
  ["lib/webmcp/groups/scenarios.ts", 6],
  ["lib/webmcp/groups/servers.ts", 3],
  ["lib/webmcp/groups/swarms.ts", 3],
  ["lib/webmcp/ui-actions.ts", 1],
  ["lib/xaa/error-guidance.ts", 7],
  ["lib/xaa/idjag-lint.ts", 3],
  ["lib/xaa/sequence-actions.ts", 2],
  ["lib/xaa/step-metadata.ts", 22],
  ["router.tsx", 1],
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Every source spelling the counter understands, so the fast path below can
// never skip a file the AST pass would have flagged.
function mayCarryEmDash(source: string): boolean {
  return (
    source.includes(EM_DASH) ||
    source.includes("\\u2014") ||
    source.includes("\\u{2014}") ||
    source.match(EM_DASH_ENTITY) !== null
  );
}

function copyText(node: ts.Node): string | null {
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
      // An attribute value is the one string literal JSX decodes, and the AST
      // hands it back raw. Everywhere else the entity is just text.
      return ts.isJsxAttribute(node.parent)
        ? (node as ts.StringLiteral).text.replace(EM_DASH_ENTITY, EM_DASH)
        : (node as ts.StringLiteral).text;
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateHead:
    case ts.SyntaxKind.TemplateMiddle:
    case ts.SyntaxKind.TemplateTail:
      return (node as ts.LiteralLikeNode).text;
    case ts.SyntaxKind.JsxText:
      return (node as ts.JsxText).text.replace(EM_DASH_ENTITY, EM_DASH);
    default:
      return null;
  }
}

function isEmptyValuePlaceholder(node: ts.Node, text: string): boolean {
  if (node.kind === ts.SyntaxKind.JsxText) {
    // JSX text carries the surrounding indentation, so it has to be trimmed.
    if (text.trim() !== EM_DASH) return false;
    const siblings = (node.parent as ts.JsxElement | ts.JsxFragment).children;
    // A JSX comment parses as an expression with nothing in it, and interpolates
    // no value, so it leaves a lone dash a placeholder.
    return !siblings.some(
      (child) => ts.isJsxExpression(child) && child.expression !== undefined,
    );
  }
  // A quoted dash is padded only to sit between two things, as `{" — "}` and
  // `join(" — ")` do, and that is a separator inside a sentence.
  if (text !== EM_DASH) return false;
  // A template chunk always sits next to an interpolation.
  return (
    node.kind === ts.SyntaxKind.StringLiteral ||
    node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
  );
}

function copyEmDashCount(file: string): number {
  const source = readFileSync(file, "utf8");
  if (!mayCarryEmDash(source)) return 0;
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let count = 0;
  const visit = (node: ts.Node) => {
    const text = copyText(node);
    if (text !== null && !isEmptyValuePlaceholder(node, text)) {
      count += text.split(EM_DASH).length - 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return count;
}

describe("em dash ratchet", () => {
  const counts = new Map(
    sourceFiles(CLIENT_SRC)
      // Normalize Windows separators so the legacy lookups match on any OS.
      .map((file) => [relative(CLIENT_SRC, file).split(sep).join("/"), file])
      .filter(([rel]) => !SKIPPED_ROOTS.some((root) => rel.startsWith(root)))
      .map(([rel, file]) => [rel, copyEmDashCount(file)] as const),
  );

  it("no file carries more em dashes in its copy than the frozen count", () => {
    const regressions = [...counts]
      .filter(([file, count]) => count > (LEGACY_EM_DASH_COPY.get(file) ?? 0))
      .map(
        ([file, count]) =>
          `${file}: ${count}, allowed ${LEGACY_EM_DASH_COPY.get(file) ?? 0}`,
      );
    expect(regressions).toEqual([]);
  });

  it("files that shed em dashes are lowered or dropped from the legacy list", () => {
    const stale = [...LEGACY_EM_DASH_COPY]
      .filter(([file, allowed]) => (counts.get(file) ?? 0) < allowed)
      .map(
        ([file, allowed]) =>
          `${file}: ${counts.get(file) ?? 0}, list says ${allowed}`,
      );
    expect(stale).toEqual([]);
  });
});
