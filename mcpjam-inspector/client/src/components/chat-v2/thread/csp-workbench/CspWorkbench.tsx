/**
 * CspWorkbench
 *
 * Three-tab diagnostic surface inside ToolPart, replacing the older
 * sandbox-debug-panel. Re-uses the data the renderer already publishes
 * via `widget-debug-store` — no new postMessage, no new backend.
 *
 *   Findings (default) — classified violations + per-class CTAs
 *   Policy Diff         — Requested · Effective · Observed
 *   Sandbox Stack       — outer proxy iframe + inner View iframe
 */

import { useCallback, useMemo, useState } from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@mcpjam/design-system/tabs";
import type {
  WidgetLifecycleEvent,
  WidgetMount,
  WidgetSandboxApplied,
  WidgetSandboxInfo,
} from "@/stores/widget-debug-store";
import { classifyDiagnoses } from "./classify";
import type { ClassifierInput } from "./types";
import { FindingsTab } from "./FindingsTab";
import { PolicyDiffTab } from "./PolicyDiffTab";
import { SandboxStackTab } from "./SandboxStackTab";

type TabKey = "findings" | "policy-diff" | "sandbox";

/** Subset of the existing `sandboxInfo` prop the workbench needs. Mirrors
 *  the shape `tool-part.tsx` already constructs. */
export interface CspWorkbenchProps {
  sandboxInfo?: Omit<WidgetSandboxInfo, "violations"> & {
    violations: WidgetSandboxInfo["violations"];
    applied?: WidgetSandboxApplied;
    lifecycle?: WidgetLifecycleEvent[];
    mounts?: WidgetMount[];
    hostInfo?: { name: string; version: string } | null;
  };
  protocol?: "openai-apps" | "mcp-apps";
}

export function CspWorkbench({ sandboxInfo, protocol }: CspWorkbenchProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("findings");
  const [jumpToHost, setJumpToHost] = useState<string | null>(null);

  const input = useMemo<ClassifierInput>(
    () => ({
      effective: {
        connectDomains: sandboxInfo?.connectDomains ?? [],
        resourceDomains: sandboxInfo?.resourceDomains ?? [],
        frameDomains: sandboxInfo?.frameDomains,
        baseUriDomains: sandboxInfo?.baseUriDomains,
      },
      widgetDeclared: sandboxInfo?.widgetDeclared ?? null,
      violations: sandboxInfo?.violations ?? [],
    }),
    [sandboxInfo],
  );

  const diagnoses = useMemo(() => classifyDiagnoses(input), [input]);

  const handleViewPolicyDiff = useCallback((host: string) => {
    setJumpToHost(host);
    setActiveTab("policy-diff");
  }, []);

  // Absence-of-data: keep parity with the old panel — return null rather
  // than rendering an empty workbench.
  if (!sandboxInfo) return null;

  return (
    <div className="space-y-3">
      <Tabs
        value={activeTab}
        onValueChange={(v: string) => {
          setActiveTab(v as TabKey);
          if (v !== "policy-diff") setJumpToHost(null);
        }}
      >
        <TabsList className="h-8">
          <TabsTrigger value="findings" className="text-[11.5px]">
            Findings
          </TabsTrigger>
          <TabsTrigger value="policy-diff" className="text-[11.5px]">
            Policy Diff
          </TabsTrigger>
          <TabsTrigger value="sandbox" className="text-[11.5px]">
            Sandbox Stack
          </TabsTrigger>
        </TabsList>

        <TabsContent value="findings" className="mt-3">
          <FindingsTab
            diagnoses={diagnoses}
            onViewPolicyDiff={handleViewPolicyDiff}
          />
        </TabsContent>

        <TabsContent value="policy-diff" className="mt-3">
          <PolicyDiffTab
            input={input}
            diagnoses={diagnoses}
            jumpToHost={jumpToHost}
            onJumpHandled={() => setJumpToHost(null)}
          />
        </TabsContent>

        <TabsContent value="sandbox" className="mt-3">
          <SandboxStackTab
            applied={sandboxInfo.applied}
            lifecycle={sandboxInfo.lifecycle}
            mounts={sandboxInfo.mounts}
            hostInfo={sandboxInfo.hostInfo}
            protocol={protocol}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
