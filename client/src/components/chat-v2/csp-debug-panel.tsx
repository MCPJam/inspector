/**
 * CspDebugPanel
 *
 * Educational CSP panel that helps developers understand and test
 * Content Security Policy for ChatGPT widgets.
 */

import { AlertCircle, ExternalLink, Info, Shield, ShieldCheck } from "lucide-react";
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

const CSP_MODE_CONFIG: Record<
  CspMode,
  {
    label: string;
    description: string;
    icon: typeof Shield;
    color: string;
    bgColor: string;
  }
> = {
  permissive: {
    label: "Permissive",
    description: "Like ChatGPT's default - allows most HTTPS resources",
    icon: ShieldCheck,
    color: "text-green-600 dark:text-green-400",
    bgColor: "bg-green-500/10",
  },
  "widget-declared": {
    label: "Widget-declared",
    description: "Only allows domains from openai/widgetCSP metadata",
    icon: Shield,
    color: "text-amber-600 dark:text-amber-400",
    bgColor: "bg-amber-500/10",
  },
};

export function CspDebugPanel({
  cspInfo,
  onModeChange,
  canChangeMode = false,
}: CspDebugPanelProps) {
  const currentMode = cspInfo?.mode ?? "permissive";
  const modeConfig = CSP_MODE_CONFIG[currentMode];
  const ModeIcon = modeConfig.icon;

  // Filter out internal CSP values for cleaner display
  const filterDisplayDomains = (domains: string[] | undefined) => {
    if (!domains?.length) return [];
    return domains.filter(
      (d) =>
        !d.startsWith("'") && // Skip 'self', 'unsafe-inline', etc.
        !d.startsWith("data:") &&
        !d.startsWith("blob:") &&
        !d.startsWith("http://localhost") &&
        !d.startsWith("http://127.0.0.1") &&
        !d.startsWith("https://localhost") &&
        !d.startsWith("https://127.0.0.1") &&
        !d.startsWith("ws://localhost") &&
        !d.startsWith("ws://127.0.0.1") &&
        !d.startsWith("wss://localhost")
    );
  };

  const displayConnectDomains = filterDisplayDomains(cspInfo?.connectDomains);
  const displayResourceDomains = filterDisplayDomains(cspInfo?.resourceDomains);
  const hasViolations = (cspInfo?.violations?.length ?? 0) > 0;

  return (
    <div className="space-y-4 text-xs">
      {/* CSP Mode Selector */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs font-medium">CSP Enforcement Mode</Label>
          <Tooltip>
            <TooltipTrigger>
              <Info className="h-3 w-3 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p>
                Test how your widget behaves under different Content Security
                Policy restrictions before deploying to ChatGPT.
              </p>
            </TooltipContent>
          </Tooltip>
        </div>

        {canChangeMode ? (
          <Select
            value={currentMode}
            onValueChange={(v) => onModeChange?.(v as CspMode)}
          >
            <SelectTrigger className="h-auto py-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(CSP_MODE_CONFIG).map(([mode, config]) => {
                const Icon = config.icon;
                return (
                  <SelectItem key={mode} value={mode} className="py-2">
                    <div className="flex items-start gap-2">
                      <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", config.color)} />
                      <div className="flex flex-col items-start">
                        <span className={cn("font-medium", config.color)}>
                          {config.label}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {config.description}
                        </span>
                      </div>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        ) : (
          <div
            className={cn(
              "flex items-center gap-2 p-2 rounded-md border",
              modeConfig.bgColor
            )}
          >
            <ModeIcon className={cn("h-4 w-4 shrink-0", modeConfig.color)} />
            <div className="flex flex-col">
              <span className={cn("font-medium text-xs", modeConfig.color)}>
                {modeConfig.label}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {modeConfig.description}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Violations Alert */}
      {hasViolations && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 p-2 rounded-md bg-destructive/10 border border-destructive/20">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
            <div>
              <div className="font-medium text-destructive">
                {cspInfo!.violations.length} blocked request
                {cspInfo!.violations.length > 1 ? "s" : ""}
              </div>
              <div className="text-[10px] text-muted-foreground">
                These requests were blocked by CSP
              </div>
            </div>
          </div>
          <div className="space-y-1 max-h-32 overflow-auto">
            {cspInfo!.violations.map((v, i) => (
              <div
                key={i}
                className="p-2 rounded-md bg-muted/50 border text-[10px] space-y-0.5"
              >
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">
                    {v.effectiveDirective || v.directive}
                  </Badge>
                </div>
                <div className="font-mono text-muted-foreground truncate">
                  {v.blockedUri || "(inline resource)"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* What's Allowed Section */}
      <div className="space-y-3">
        <Label className="text-xs font-medium">What your widget can access</Label>

        {/* API Calls */}
        <div className="space-y-1">
          <div className="text-[10px] text-muted-foreground font-medium">
            API calls (fetch/XHR)
          </div>
          <div className="p-2 rounded-md bg-muted/30 border">
            {currentMode === "permissive" ? (
              <div className="text-[10px] text-muted-foreground">
                Any HTTPS endpoint
              </div>
            ) : displayConnectDomains.length > 0 ? (
              <div className="space-y-0.5">
                {displayConnectDomains.map((domain, i) => (
                  <div
                    key={i}
                    className="font-mono text-[10px] text-foreground truncate"
                  >
                    {domain}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[10px] text-muted-foreground italic">
                No external APIs declared in openai/widgetCSP
              </div>
            )}
          </div>
        </div>

        {/* External Resources */}
        <div className="space-y-1">
          <div className="text-[10px] text-muted-foreground font-medium">
            External resources (scripts, styles, fonts)
          </div>
          <div className="p-2 rounded-md bg-muted/30 border">
            {currentMode === "permissive" ? (
              <div className="text-[10px] text-muted-foreground">
                Any HTTPS resource
              </div>
            ) : displayResourceDomains.length > 0 ? (
              <div className="space-y-0.5">
                {displayResourceDomains.map((domain, i) => (
                  <div
                    key={i}
                    className="font-mono text-[10px] text-foreground truncate"
                  >
                    {domain}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[10px] text-muted-foreground italic">
                No external resources declared in openai/widgetCSP
              </div>
            )}
          </div>
        </div>

        {/* Always Allowed Note */}
        <div className="text-[10px] text-muted-foreground bg-muted/20 p-2 rounded-md">
          <span className="font-medium">Always allowed:</span> Same-origin resources,
          data: URIs, blob: URIs, inline scripts/styles
        </div>
      </div>

      {/* Full CSP Header (collapsed by default) */}
      {cspInfo?.headerString && (
        <details className="group">
          <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground flex items-center gap-1">
            <span className="group-open:hidden">Show</span>
            <span className="hidden group-open:inline">Hide</span>
            {" "}full CSP header
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
