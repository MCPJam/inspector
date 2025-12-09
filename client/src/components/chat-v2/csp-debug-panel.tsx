/**
 * CspDebugPanel
 *
 * Displays CSP configuration and violation info for a widget.
 * Allows toggling between CSP enforcement modes.
 */

import { AlertCircle, ExternalLink, Info } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CspMode } from "@/stores/ui-playground-store";
import type { CspViolation } from "@/stores/widget-debug-store";

interface CspDebugPanelProps {
  /** Current CSP configuration */
  cspInfo?: {
    mode: CspMode;
    connectDomains: string[];
    resourceDomains: string[];
    headerString?: string;
    violations: CspViolation[];
  };
  /** Callback when CSP mode changes */
  onModeChange?: (mode: CspMode) => void;
  /** Whether mode can be changed (false in chat tab, true in playground) */
  canChangeMode?: boolean;
}

const CSP_MODE_LABELS: Record<
  CspMode,
  { label: string; description: string; color: string }
> = {
  permissive: {
    label: "Permissive",
    description: "Allow https: wildcard - most lenient",
    color: "text-green-600 dark:text-green-400",
  },
  "widget-declared": {
    label: "Widget-declared",
    description: "Honor openai/widgetCSP metadata from resource",
    color: "text-yellow-600 dark:text-yellow-400",
  },
  strict: {
    label: "Maximum-strict",
    description: "Only 'self', data:, blob: - block all external",
    color: "text-red-600 dark:text-red-400",
  },
};

export function CspDebugPanel({
  cspInfo,
  onModeChange,
  canChangeMode = false,
}: CspDebugPanelProps) {
  const currentMode = cspInfo?.mode ?? "permissive";
  const modeConfig = CSP_MODE_LABELS[currentMode];

  return (
    <div className="space-y-4 text-xs">
      {/* CSP Mode Selector */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Label className="text-xs font-medium">CSP Enforcement Mode</Label>
          <Tooltip>
            <TooltipTrigger>
              <Info className="h-3 w-3 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p>
                Content Security Policy controls which external resources the
                widget can load. Stricter modes help identify potential issues
                before deploying to ChatGPT.
              </p>
            </TooltipContent>
          </Tooltip>
        </div>

        {canChangeMode ? (
          <Select
            value={currentMode}
            onValueChange={(v) => onModeChange?.(v as CspMode)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(CSP_MODE_LABELS).map(([mode, config]) => (
                <SelectItem key={mode} value={mode}>
                  <div className="flex flex-col items-start">
                    <span className={cn("font-medium", config.color)}>
                      {config.label}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {config.description}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex items-center gap-2 py-1">
            <Badge variant="outline" className={cn("text-xs", modeConfig.color)}>
              {modeConfig.label}
            </Badge>
            <span className="text-muted-foreground text-[10px]">
              {modeConfig.description}
            </span>
          </div>
        )}
      </div>

      {/* Violations List */}
      {(cspInfo?.violations?.length ?? 0) > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
            <Label className="text-xs font-medium text-destructive">
              {cspInfo!.violations.length} CSP Violation
              {cspInfo!.violations.length > 1 ? "s" : ""}
            </Label>
          </div>
          <div className="space-y-1 max-h-40 overflow-auto">
            {cspInfo!.violations.map((v, i) => (
              <div
                key={i}
                className="p-2 rounded-md bg-destructive/10 border border-destructive/20 text-[10px]"
              >
                <div className="font-medium text-destructive truncate">
                  {v.effectiveDirective || v.directive}
                </div>
                <div className="font-mono text-muted-foreground truncate">
                  {v.blockedUri || "(empty)"}
                </div>
                {v.sourceFile && (
                  <div className="text-muted-foreground/70 truncate">
                    {v.sourceFile}
                    {v.lineNumber ? `:${v.lineNumber}` : ""}
                    {v.columnNumber ? `:${v.columnNumber}` : ""}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Connect Domains */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium text-muted-foreground">
          Allowed Connect Sources (fetch/XHR)
        </Label>
        <div className="font-mono text-[10px] bg-muted/50 p-2 rounded-md max-h-20 overflow-auto border">
          {cspInfo?.connectDomains?.length ? (
            cspInfo.connectDomains.map((domain, i) => (
              <div key={i} className="truncate">
                {domain}
              </div>
            ))
          ) : (
            <span className="text-muted-foreground">'self'</span>
          )}
        </div>
      </div>

      {/* Resource Domains */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium text-muted-foreground">
          Allowed Resource Sources (scripts/styles/fonts)
        </Label>
        <div className="font-mono text-[10px] bg-muted/50 p-2 rounded-md max-h-20 overflow-auto border">
          {cspInfo?.resourceDomains?.length ? (
            cspInfo.resourceDomains.map((domain, i) => (
              <div key={i} className="truncate">
                {domain}
              </div>
            ))
          ) : (
            <span className="text-muted-foreground">'self' data: blob:</span>
          )}
        </div>
      </div>

      {/* Full CSP Header (collapsible for advanced users) */}
      {cspInfo?.headerString && (
        <details className="group">
          <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
            View full CSP header
          </summary>
          <div className="mt-1.5 font-mono text-[9px] bg-muted/50 p-2 rounded-md max-h-32 overflow-auto border break-all">
            {cspInfo.headerString}
          </div>
        </details>
      )}

      {/* Help link */}
      <a
        href="https://developers.openai.com/apps-sdk/reference/#component-resource-configuration"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
      >
        <ExternalLink className="h-3 w-3" />
        Learn about openai/widgetCSP metadata
      </a>
    </div>
  );
}
