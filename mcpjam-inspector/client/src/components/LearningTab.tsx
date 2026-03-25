import { useState, useMemo, useCallback } from "react";
import { McpLifecycleDiagram } from "@/components/lifecycle/McpLifecycleDiagram";
import { McpLifecycleGuide } from "@/components/lifecycle/McpLifecycleGuide";
import { buildMcpLifecycleScenario20250326 } from "@/components/lifecycle/mcp-lifecycle-data";
import {
  HTTP_STEP_ORDER,
  isLastHttpLifecycleStep,
  nextHttpLifecycleStepId,
} from "@/components/lifecycle/mcp-lifecycle-guide-data";
import { LearningLandingPage } from "@/components/LearningLandingPage";
import { WhatIsMcpDiagram } from "@/components/what-is-mcp/WhatIsMcpDiagram";
import { WhatIsMcpGuide } from "@/components/what-is-mcp/WhatIsMcpGuide";
import { WHAT_IS_MCP_STEP_ORDER } from "@/components/what-is-mcp/what-is-mcp-data";
import {
  isLastWhatIsMcpStep,
  nextWhatIsMcpStepId,
} from "@/components/what-is-mcp/what-is-mcp-guide-data";
import { McpAppsDiagram } from "@/components/mcp-apps/McpAppsDiagram";
import { McpAppsGuide } from "@/components/mcp-apps/McpAppsGuide";
import { MCP_APPS_STEP_ORDER } from "@/components/mcp-apps/mcp-apps-data";
import {
  isLastMcpAppsStep,
  nextMcpAppsStepId,
} from "@/components/mcp-apps/mcp-apps-guide-data";
import { AppsSdkDiagram } from "@/components/apps-sdk/AppsSdkDiagram";
import { AppsSdkGuide } from "@/components/apps-sdk/AppsSdkGuide";
import { APPS_SDK_STEP_ORDER } from "@/components/apps-sdk/apps-sdk-data";
import {
  isLastAppsSdkStep,
  nextAppsSdkStepId,
} from "@/components/apps-sdk/apps-sdk-guide-data";
import { useWalkthrough } from "@/hooks/use-walkthrough";
import { WalkthroughShell } from "@/components/walkthrough/WalkthroughShell";
import { ArticleShell } from "@/components/learning-article/ArticleShell";
import { WhyMcpArticle } from "@/components/why-mcp/WhyMcpArticle";
import { McpVsCliArticle } from "@/components/mcp-vs-cli/McpVsCliArticle";
import { McpVsApiArticle } from "@/components/mcp-vs-api/McpVsApiArticle";
import { McpVsSkillsArticle } from "@/components/mcp-vs-skills/McpVsSkillsArticle";
import { McpToolsArticle } from "@/components/mcp-tools/McpToolsArticle";
import { McpResourcesArticle } from "@/components/mcp-resources/McpResourcesArticle";
import { McpPromptsArticle } from "@/components/mcp-prompts/McpPromptsArticle";

/**
 * Sentinel value used as `currentStep` when the lifecycle walkthrough is at step 0.
 * It won't match any real action ID, which makes action[0] get "current" status.
 */
const WALKTHROUGH_START_SENTINEL = "__walkthrough_start__";

// ---------------------------------------------------------------------------
// MCP Lifecycle Walkthrough
// ---------------------------------------------------------------------------

function McpLifecycleWalkthrough({ onBack }: { onBack: () => void }) {
  const scenario = useMemo(
    () => buildMcpLifecycleScenario20250326({ transport: "http" }),
    [],
  );

  const wt = useWalkthrough({
    stepOrder: HTTP_STEP_ORDER,
    isLastStep: isLastHttpLifecycleStep,
    nextStepId: nextHttpLifecycleStepId,
    mapToDiagramStep: useCallback(
      (activeStepId: string | undefined) => {
        if (!activeStepId) return undefined;
        const idx = HTTP_STEP_ORDER.indexOf(
          activeStepId as (typeof HTTP_STEP_ORDER)[number],
        );
        if (idx < 0) return undefined;
        if (idx === 0) return WALKTHROUGH_START_SENTINEL;
        return scenario.actions[idx - 1].id;
      },
      [scenario.actions],
    ),
  });

  return (
    <WalkthroughShell
      title="MCP Protocol Lifecycle"
      badge="HTTP"
      onBack={onBack}
      continueLabel={wt.continueLabel}
      onContinue={wt.handleContinue}
      onReset={wt.handleReset}
      guidePanel={
        <McpLifecycleGuide
          activeStepId={wt.activeStepId}
          onActiveStepChange={wt.handleScrollStepChange}
          scrollToStepId={wt.scrollTargetStepId}
          scrollToStepToken={wt.scrollToStepToken}
          onScrollComplete={wt.handleScrollComplete}
        />
      }
      diagramPanel={
        <McpLifecycleDiagram
          transport="http"
          currentStep={wt.currentStep}
          focusedStep={wt.activeStepId}
          onStepClick={wt.scrollToStep}
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// "What is MCP?" Walkthrough
// ---------------------------------------------------------------------------

function WhatIsMcpWalkthrough({ onBack }: { onBack: () => void }) {
  const wt = useWalkthrough({
    stepOrder: WHAT_IS_MCP_STEP_ORDER,
    isLastStep: isLastWhatIsMcpStep,
    nextStepId: nextWhatIsMcpStepId,
  });

  const handleDiagramStepClick = useCallback(
    (nodeId: string) => {
      const nodeToStep: Record<string, string> = {
        "host-group": "host_app",
        "llm-app": "host_app",
        "mcp-client": "mcp_client",
        "server-tools": "mcp_servers",
        "server-resources": "mcp_servers",
        "server-prompts": "mcp_servers",
        tools: "tools",
        resources: "resources",
        prompts: "prompts",
      };
      const stepId = nodeToStep[nodeId] ?? nodeId;
      if (
        WHAT_IS_MCP_STEP_ORDER.includes(
          stepId as (typeof WHAT_IS_MCP_STEP_ORDER)[number],
        )
      ) {
        wt.scrollToStep(stepId);
      }
    },
    [wt.scrollToStep],
  );

  return (
    <WalkthroughShell
      title="What is MCP?"
      badge="Fundamentals"
      onBack={onBack}
      continueLabel={wt.continueLabel}
      onContinue={wt.handleContinue}
      onReset={wt.handleReset}
      guidePanel={
        <WhatIsMcpGuide
          activeStepId={wt.activeStepId}
          onActiveStepChange={wt.handleScrollStepChange}
          scrollToStepId={wt.scrollTargetStepId}
          scrollToStepToken={wt.scrollToStepToken}
          onScrollComplete={wt.handleScrollComplete}
        />
      }
      diagramPanel={
        <WhatIsMcpDiagram
          currentStep={wt.currentStep}
          onStepClick={handleDiagramStepClick}
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// MCP Apps walkthrough
// ---------------------------------------------------------------------------

function McpAppsWalkthrough({ onBack }: { onBack: () => void }) {
  const wt = useWalkthrough({
    stepOrder: MCP_APPS_STEP_ORDER,
    isLastStep: isLastMcpAppsStep,
    nextStepId: nextMcpAppsStepId,
  });

  const handleDiagramStepClick = useCallback(
    (diagramId: string) => {
      const nodeToStep: Record<string, string> = {
        "host-group": "host_client",
        "ai-client": "host_client",
        "iframe-view": "iframe_view",
        "tool-code": "tool_definition",
        "resource-code": "ui_resource",
        "widget-file": "widget_component",
      };
      const edgeToStep: Record<string, string> = {
        "e-step1": "tool_definition",
        "e-step2": "ui_resource",
        "e-step3": "widget_component",
        "e-step4": "iframe_view",
        "e-postmessage": "iframe_view",
      };
      const stepId =
        nodeToStep[diagramId] ?? edgeToStep[diagramId] ?? diagramId;
      if (
        MCP_APPS_STEP_ORDER.includes(
          stepId as (typeof MCP_APPS_STEP_ORDER)[number],
        )
      ) {
        wt.scrollToStep(stepId);
      }
    },
    [wt.scrollToStep],
  );

  return (
    <WalkthroughShell
      title="MCP Apps"
      badge="Extensions"
      onBack={onBack}
      continueLabel={wt.continueLabel}
      onContinue={wt.handleContinue}
      onReset={wt.handleReset}
      guidePanel={
        <McpAppsGuide
          activeStepId={wt.activeStepId}
          onActiveStepChange={wt.handleScrollStepChange}
          scrollToStepId={wt.scrollTargetStepId}
          scrollToStepToken={wt.scrollToStepToken}
          onScrollComplete={wt.handleScrollComplete}
        />
      }
      diagramPanel={
        <McpAppsDiagram
          currentStep={wt.currentStep}
          onStepClick={handleDiagramStepClick}
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Apps SDK walkthrough
// ---------------------------------------------------------------------------

function AppsSdkWalkthrough({ onBack }: { onBack: () => void }) {
  const wt = useWalkthrough({
    stepOrder: APPS_SDK_STEP_ORDER,
    isLastStep: isLastAppsSdkStep,
    nextStepId: nextAppsSdkStepId,
  });

  const handleDiagramStepClick = useCallback(
    (diagramId: string) => {
      const nodeToStep: Record<string, string> = {
        "host-group": "host_model",
        "ai-model": "host_model",
        "iframe-view": "iframe_view",
        "tool-code": "tool_definition",
        "result-code": "tool_result",
        "widget-file": "widget_component",
      };
      const edgeToStep: Record<string, string> = {
        "e-step1": "tool_definition",
        "e-step2": "tool_result",
        "e-step3": "widget_component",
        "e-step4": "iframe_view",
        "e-postmessage": "iframe_view",
      };
      const stepId =
        nodeToStep[diagramId] ?? edgeToStep[diagramId] ?? diagramId;
      if (
        APPS_SDK_STEP_ORDER.includes(
          stepId as (typeof APPS_SDK_STEP_ORDER)[number],
        )
      ) {
        wt.scrollToStep(stepId);
      }
    },
    [wt.scrollToStep],
  );

  return (
    <WalkthroughShell
      title="OpenAI Apps SDK"
      badge="Extensions"
      onBack={onBack}
      continueLabel={wt.continueLabel}
      onContinue={wt.handleContinue}
      onReset={wt.handleReset}
      guidePanel={
        <AppsSdkGuide
          activeStepId={wt.activeStepId}
          onActiveStepChange={wt.handleScrollStepChange}
          scrollToStepId={wt.scrollTargetStepId}
          scrollToStepToken={wt.scrollToStepToken}
          onScrollComplete={wt.handleScrollComplete}
        />
      }
      diagramPanel={
        <AppsSdkDiagram
          currentStep={wt.currentStep}
          onStepClick={handleDiagramStepClick}
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// LearningTab — routes to the selected concept
// ---------------------------------------------------------------------------

export function LearningTab() {
  const [selectedConcept, setSelectedConcept] = useState<string | null>(null);

  if (selectedConcept === "why-mcp") {
    return (
      <ArticleShell
        title="Why MCP?"
        badge="Concepts"
        onBack={() => setSelectedConcept(null)}
      >
        <WhyMcpArticle />
      </ArticleShell>
    );
  }

  if (selectedConcept === "what-is-mcp") {
    return <WhatIsMcpWalkthrough onBack={() => setSelectedConcept(null)} />;
  }

  if (selectedConcept === "mcp-apps") {
    return <McpAppsWalkthrough onBack={() => setSelectedConcept(null)} />;
  }

  if (selectedConcept === "apps-sdk") {
    return <AppsSdkWalkthrough onBack={() => setSelectedConcept(null)} />;
  }

  if (selectedConcept === "mcp-lifecycle") {
    return <McpLifecycleWalkthrough onBack={() => setSelectedConcept(null)} />;
  }

  if (selectedConcept === "mcp-tools") {
    return (
      <ArticleShell
        title="MCP Tools"
        badge="Protocol"
        onBack={() => setSelectedConcept(null)}
      >
        <McpToolsArticle />
      </ArticleShell>
    );
  }

  if (selectedConcept === "mcp-resources") {
    return (
      <ArticleShell
        title="MCP Resources"
        badge="Protocol"
        onBack={() => setSelectedConcept(null)}
      >
        <McpResourcesArticle />
      </ArticleShell>
    );
  }

  if (selectedConcept === "mcp-prompts") {
    return (
      <ArticleShell
        title="MCP Prompts"
        badge="Protocol"
        onBack={() => setSelectedConcept(null)}
      >
        <McpPromptsArticle />
      </ArticleShell>
    );
  }

  if (selectedConcept === "mcp-vs-cli") {
    return (
      <ArticleShell
        title="MCP vs CLI"
        badge="Comparisons"
        onBack={() => setSelectedConcept(null)}
      >
        <McpVsCliArticle />
      </ArticleShell>
    );
  }

  if (selectedConcept === "mcp-vs-api") {
    return (
      <ArticleShell
        title="MCP vs REST APIs"
        badge="Comparisons"
        onBack={() => setSelectedConcept(null)}
      >
        <McpVsApiArticle />
      </ArticleShell>
    );
  }

  if (selectedConcept === "mcp-vs-skills") {
    return (
      <ArticleShell
        title="MCP vs Skills"
        badge="Comparisons"
        onBack={() => setSelectedConcept(null)}
      >
        <McpVsSkillsArticle />
      </ArticleShell>
    );
  }

  return <LearningLandingPage onSelect={setSelectedConcept} />;
}
