/**
 * CspDebugPanel
 *
 * Debug panel showing CSP configuration details and violations.
 * The CSP mode selector has been moved to the PlaygroundMain header.
 */

import { AlertCircle, ExternalLink } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { CspMode } from "@/stores/ui-playground-store";
import type { CspViolation } from "@/stores/widget-debug-store";

interface CspDebugPanelProps {
  cspInfo?: {
    mode: CspMode;
    connectDomains: string[];
    resourceDomains: string[];
    headerString?: string;
    violations: CspViolation[];
    widgetDeclared?: {
      connect_domains?: string[];
      resource_domains?: string[];
    } | null;
  };
}

const CSP_MODE_LABELS: Record<CspMode, string> = {
  permissive: "Permissive",
  "widget-declared": "Strict",
};

export function CspDebugPanel({ cspInfo }: CspDebugPanelProps) {
  const currentMode = cspInfo?.mode ?? "permissive";
  const hasViolations = (cspInfo?.violations?.length ?? 0) > 0;

  // Get widget's declared domains (what they put in openai/widgetCSP)
  const declaredConnectDomains = cspInfo?.widgetDeclared?.connect_domains ?? [];
  const declaredResourceDomains =
    cspInfo?.widgetDeclared?.resource_domains ?? [];

  return (
    <div className="space-y-4 text-xs">

      {/* Violations */}
      {hasViolations && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-destructive">
            <AlertCircle className="h-3.5 w-3.5" />
            <span className="font-medium">
              {cspInfo!.violations.length} blocked
            </span>
          </div>
          <div className="space-y-1 max-h-28 overflow-auto">
            {cspInfo!.violations.map((v, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
              >
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 shrink-0">
                  {v.effectiveDirective || v.directive}
                </Badge>
                <span className="font-mono truncate">
                  {v.blockedUri || "(inline)"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Widget's Declared CSP */}
      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">
            connect_domains
          </Label>
          <div className="text-[10px]">
            {currentMode === "permissive" ? (
              <span className="text-muted-foreground italic">Not enforced in permissive mode</span>
            ) : declaredConnectDomains.length > 0 ? (
              <div className="font-mono space-y-0.5">
                {declaredConnectDomains.map((d, i) => (
                  <div key={i} className="truncate">{d}</div>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground italic">
                Not declared
              </span>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">
            resource_domains
          </Label>
          <div className="text-[10px]">
            {currentMode === "permissive" ? (
              <span className="text-muted-foreground italic">Not enforced in permissive mode</span>
            ) : declaredResourceDomains.length > 0 ? (
              <div className="font-mono space-y-0.5">
                {declaredResourceDomains.map((d, i) => (
                  <div key={i} className="truncate">{d}</div>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground italic">
                Not declared
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Full header toggle */}
      {cspInfo?.headerString && (
        <details>
          <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
            Full CSP header
          </summary>
          <div className="mt-1 font-mono text-[9px] text-muted-foreground bg-muted/50 p-2 rounded max-h-24 overflow-auto break-all">
            {cspInfo.headerString}
          </div>
        </details>
      )}

      {/* Docs link */}
      <a
        href="https://developers.openai.com/apps-sdk/reference/#component-resource-configuration"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
      >
        <ExternalLink className="h-3 w-3" />
        openai/widgetCSP docs
      </a>
    </div>
  );
}
