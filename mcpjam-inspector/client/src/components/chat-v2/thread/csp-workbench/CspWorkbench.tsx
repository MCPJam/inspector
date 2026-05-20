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
 *
 * Header: one-shot Export button that downloads a JSON report (also
 * triggered by ⌘E / Ctrl+E).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@mcpjam/design-system/tabs";
import { toast } from "sonner";
import type {
  WidgetLifecycleEvent,
  WidgetMount,
  WidgetSandboxApplied,
  WidgetSandboxInfo,
} from "@/stores/widget-debug-store";
import { classifyDiagnoses, summarize } from "./classify";
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

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
  const summary = useMemo(() => summarize(diagnoses), [diagnoses]);

  const handleViewPolicyDiff = useCallback((host: string) => {
    setJumpToHost(host);
    setActiveTab("policy-diff");
  }, []);

  const handleExport = useCallback(() => {
    const report = {
      protocol: protocol ?? "mcp-apps",
      generatedAt: new Date().toISOString(),
      requestedCsp: sandboxInfo?.widgetDeclared ?? null,
      effectiveCsp: {
        connectDomains: sandboxInfo?.connectDomains ?? [],
        resourceDomains: sandboxInfo?.resourceDomains ?? [],
        frameDomains: sandboxInfo?.frameDomains ?? [],
        baseUriDomains: sandboxInfo?.baseUriDomains ?? [],
        headerString: sandboxInfo?.headerString,
      },
      applied: sandboxInfo?.applied ?? null,
      summary,
      diagnoses,
      raw: {
        violations: sandboxInfo?.violations ?? [],
        lifecycle: sandboxInfo?.lifecycle ?? [],
        mounts: sandboxInfo?.mounts ?? [],
        hostInfo: sandboxInfo?.hostInfo ?? null,
      },
    };
    downloadJson("csp-workbench-report.json", report);
    toast.success("Report downloaded");
  }, [diagnoses, protocol, sandboxInfo, summary]);

  // ⌘E / Ctrl+E to export — only while the workbench is in the DOM.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      if ((isMac ? e.metaKey : e.ctrlKey) && (e.key === "e" || e.key === "E")) {
        // Only intercept when there's no text-input focus to fight with.
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        handleExport();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [handleExport]);

  // Absence-of-data: keep parity with the old panel — return null rather
  // than rendering an empty workbench.
  if (!sandboxInfo) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <Tabs
          value={activeTab}
          onValueChange={(v: string) => {
            setActiveTab(v as TabKey);
            if (v !== "policy-diff") setJumpToHost(null);
          }}
          className="flex-1"
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

        <button
          type="button"
          onClick={handleExport}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded border border-border/60 bg-transparent text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="Download a JSON report (⌘E)"
        >
          <Download className="size-3" />
          Export
          <span className="font-mono text-[10px] text-muted-foreground/70 ml-0.5">
            ⌘E
          </span>
        </button>
      </div>
    </div>
  );
}
