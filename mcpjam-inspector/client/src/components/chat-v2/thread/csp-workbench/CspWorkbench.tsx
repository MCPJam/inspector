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

import { useCallback, useEffect, useMemo, useState } from "react";
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

export interface RecordedWidgetPolicy {
  resourceUri?: string;
  csp?: unknown;
  permissions?: unknown;
  permissive?: boolean;
  prefersBorder?: boolean;
}

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
  recordedPolicy?: RecordedWidgetPolicy;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function recordedDeclaration(policy: RecordedWidgetPolicy | undefined) {
  if (!policy?.csp || typeof policy.csp !== "object") return null;
  const csp = policy.csp as Record<string, unknown>;
  return {
    connectDomains: stringList(csp.connectDomains),
    resourceDomains: stringList(csp.resourceDomains),
    frameDomains: stringList(csp.frameDomains),
    baseUriDomains: stringList(csp.baseUriDomains),
    connect_domains: stringList(csp.connect_domains),
    resource_domains: stringList(csp.resource_domains),
  };
}

export function CspWorkbench({
  sandboxInfo,
  protocol,
  recordedPolicy,
}: CspWorkbenchProps) {
  const [activeTab, setActiveTab] = useState<TabKey>(() =>
    recordedPolicy ? "policy-diff" : "findings",
  );
  const [jumpToHost, setJumpToHost] = useState<string | null>(null);
  const isRecorded = !!recordedPolicy;

  const input = useMemo<ClassifierInput>(
    () => ({
      effective: {
        connectDomains: isRecorded ? [] : (sandboxInfo?.connectDomains ?? []),
        resourceDomains: isRecorded ? [] : (sandboxInfo?.resourceDomains ?? []),
        frameDomains: isRecorded ? undefined : sandboxInfo?.frameDomains,
        baseUriDomains: isRecorded ? undefined : sandboxInfo?.baseUriDomains,
      },
      widgetDeclared: isRecorded
        ? recordedDeclaration(recordedPolicy)
        : (sandboxInfo?.widgetDeclared ?? null),
      subtypePolicy: isRecorded
        ? undefined
        : sandboxInfo?.applied?.cspSubtypePolicy,
      violations: isRecorded ? [] : (sandboxInfo?.violations ?? []),
    }),
    [isRecorded, recordedPolicy, sandboxInfo],
  );

  const diagnoses = useMemo(() => classifyDiagnoses(input), [input]);

  const handleViewPolicyDiff = useCallback((host: string) => {
    setJumpToHost(host);
    setActiveTab("policy-diff");
  }, []);

  useEffect(() => {
    if (isRecorded && activeTab === "findings") {
      setActiveTab("policy-diff");
    }
  }, [activeTab, isRecorded]);

  // Absence-of-data: keep parity with the old panel — return null rather
  // than rendering an empty workbench.
  if (!sandboxInfo && !recordedPolicy) return null;

  return (
    <div
      className="space-y-3"
      data-testid={isRecorded ? "recorded-widget-diagnostics" : undefined}
    >
      {isRecorded && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            Recorded widget policy
          </div>
          <div className="text-[10px] text-muted-foreground">
            Saved with this eval run; live policy and violations are
            unavailable.
          </div>
        </div>
      )}
      <Tabs
        value={activeTab}
        onValueChange={(v: string) => {
          setActiveTab(v as TabKey);
          if (v !== "policy-diff") setJumpToHost(null);
        }}
      >
        <TabsList className="h-8">
          {!isRecorded && (
            <TabsTrigger value="findings" className="text-[11.5px]">
              Findings
            </TabsTrigger>
          )}
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
            declaredDomain={sandboxInfo?.declaredDomain}
            assignedOrigin={sandboxInfo?.applied?.assignedOrigin}
          />
        </TabsContent>

        <TabsContent value="policy-diff" className="mt-3">
          <PolicyDiffTab
            input={input}
            diagnoses={diagnoses}
            recorded={isRecorded}
            jumpToHost={jumpToHost}
            onJumpHandled={() => setJumpToHost(null)}
          />
        </TabsContent>

        <TabsContent value="sandbox" className="mt-3">
          <SandboxStackTab
            applied={sandboxInfo?.applied}
            lifecycle={sandboxInfo?.lifecycle}
            mounts={sandboxInfo?.mounts}
            hostInfo={sandboxInfo?.hostInfo}
            protocol={protocol}
            recordedPolicy={recordedPolicy}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
