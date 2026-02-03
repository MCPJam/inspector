/**
 * CspDebugPanel
 *
 * Debug panel showing CSP configuration details and violations.
 * Shows actionable suggestions for fixing CSP issues.
 */

import { useMemo, useState } from "react";
import {
  AlertCircle,
  ExternalLink,
  Copy,
  Check,
  Lightbulb,
  ChevronRight,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { CspMode } from "@/stores/ui-playground-store";
import type { CspViolation } from "@/stores/widget-debug-store";

interface CspDebugPanelProps {
  cspInfo?: {
    mode: CspMode;
    connectDomains: string[];
    resourceDomains: string[];
    frameDomains?: string[];
    headerString?: string;
    violations: CspViolation[];
    widgetDeclared?: {
      connect_domains?: string[];
      resource_domains?: string[];
      frame_domains?: string[];
      connectDomains?: string[];
      resourceDomains?: string[];
      frameDomains?: string[];
      baseUriDomains?: string[];
    } | null;
  };
  protocol?: "openai-apps" | "mcp-apps";
}

/**
 * Extract origin (scheme + host) from a URL string
 */
function extractOrigin(url: string): string | null {
  if (
    !url ||
    url === "inline" ||
    url === "eval" ||
    url === "data" ||
    url === "blob"
  ) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    // Try to extract domain pattern from partial URLs
    const match = url.match(/^(https?:\/\/[^/]+)/);
    return match ? match[1] : null;
  }
}

/**
 * Determine which widgetCSP field a directive maps to
 */
function getFieldForDirective(
  directive: string,
): "connect_domains" | "resource_domains" | null {
  const effectiveDirective = directive.replace(/-src$/, "");

  // connect-src → connect_domains
  if (effectiveDirective === "connect") {
    return "connect_domains";
  }

  // script-src, style-src, img-src, font-src, media-src → resource_domains
  if (
    ["script", "style", "img", "font", "media", "default"].includes(
      effectiveDirective,
    )
  ) {
    return "resource_domains";
  }

  return null;
}

interface SuggestedFix {
  field: "connect_domains" | "resource_domains";
  domains: string[];
  violations: CspViolation[];
}

/**
 * Analyze violations and generate suggested fixes
 */
function analyzeSuggestedFixes(violations: CspViolation[]): SuggestedFix[] {
  const connectDomains = new Map<string, CspViolation[]>();
  const resourceDomains = new Map<string, CspViolation[]>();

  for (const v of violations) {
    const directive = v.effectiveDirective || v.directive;
    const field = getFieldForDirective(directive);
    const origin = extractOrigin(v.blockedUri);

    if (!field || !origin) continue;

    const targetMap =
      field === "connect_domains" ? connectDomains : resourceDomains;
    const existing = targetMap.get(origin) || [];
    existing.push(v);
    targetMap.set(origin, existing);
  }

  const fixes: SuggestedFix[] = [];

  if (connectDomains.size > 0) {
    fixes.push({
      field: "connect_domains",
      domains: Array.from(connectDomains.keys()),
      violations: Array.from(connectDomains.values()).flat(),
    });
  }

  if (resourceDomains.size > 0) {
    fixes.push({
      field: "resource_domains",
      domains: Array.from(resourceDomains.keys()),
      violations: Array.from(resourceDomains.values()).flat(),
    });
  }

  return fixes;
}

/**
 * Generate copyable code snippet for the fix
 */
function generateCodeSnippet(
  fixes: SuggestedFix[],
  existing?: {
    connect_domains?: string[];
    resource_domains?: string[];
    connectDomains?: string[];
    resourceDomains?: string[];
  } | null,
  protocol?: "openai-apps" | "mcp-apps",
): string {
  // Merge domains from both formats
  const connectDomains = new Set([
    ...(existing?.connect_domains || []),
    ...(existing?.connectDomains || []),
  ]);
  const resourceDomains = new Set([
    ...(existing?.resource_domains || []),
    ...(existing?.resourceDomains || []),
  ]);

  // Add new domains from fixes
  for (const fix of fixes) {
    const targetSet =
      fix.field === "connect_domains" ? connectDomains : resourceDomains;
    for (const domain of fix.domains) {
      targetSet.add(domain);
    }
  }

  // Generate output in the correct format based on protocol
  // Default to camelCase (MCP format) if protocol is unknown
  const useCamelCase = protocol !== "openai-apps";

  const result: Record<string, string[]> = {};
  if (connectDomains.size > 0) {
    const key = useCamelCase ? "connectDomains" : "connect_domains";
    result[key] = Array.from(connectDomains);
  }
  if (resourceDomains.size > 0) {
    const key = useCamelCase ? "resourceDomains" : "resource_domains";
    result[key] = Array.from(resourceDomains);
  }

  return JSON.stringify(result, null, 2);
}

export function CspDebugPanel({ cspInfo, protocol }: CspDebugPanelProps) {
  const currentMode = cspInfo?.mode ?? "permissive";
  const violations = cspInfo?.violations ?? [];
  const hasViolations = violations.length > 0;
  const [copied, setCopied] = useState(false);

  // Get widget's declared domains (from openai/widgetCSP or ui.csp)
  const declaredConnectDomains =
    cspInfo?.widgetDeclared?.connect_domains ??
    cspInfo?.widgetDeclared?.connectDomains ??
    [];
  const declaredResourceDomains =
    cspInfo?.widgetDeclared?.resource_domains ??
    cspInfo?.widgetDeclared?.resourceDomains ??
    [];
  const declaredFrameDomains =
    cspInfo?.widgetDeclared?.frame_domains ??
    cspInfo?.widgetDeclared?.frameDomains ??
    [];
  const declaredBaseUriDomains = cspInfo?.widgetDeclared?.baseUriDomains ?? [];

  // Analyze violations and generate suggested fixes
  const suggestedFixes = useMemo(
    () => analyzeSuggestedFixes(violations),
    [violations],
  );

  const codeSnippet = useMemo(
    () =>
      hasViolations
        ? generateCodeSnippet(suggestedFixes, cspInfo?.widgetDeclared, protocol)
        : "",
    [suggestedFixes, cspInfo?.widgetDeclared, hasViolations, protocol],
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <div className="space-y-4 text-xs">
      {/* Suggested Fix */}
      {hasViolations && suggestedFixes.length > 0 && (
        <details className="group">
          <summary className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 cursor-pointer list-none">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            <Lightbulb className="h-3.5 w-3.5" />
            <span className="font-medium">Suggested fix</span>
          </summary>
          <div className="mt-2 pl-5 space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-[10px] text-muted-foreground">
                {protocol === "mcp-apps"
                  ? "Add the following to your ui.csp field"
                  : "Add the following to your openai/widgetCSP field"}
              </Label>
              <button
                onClick={handleCopy}
                className="p-1 hover:bg-muted rounded transition-colors"
                title="Copy to clipboard"
              >
                {copied ? (
                  <Check className="h-3 w-3 text-green-500" />
                ) : (
                  <Copy className="h-3 w-3 text-muted-foreground" />
                )}
              </button>
            </div>
            <pre className="font-mono text-[10px] bg-muted/50 p-2 rounded overflow-auto max-h-32 text-foreground">
              {codeSnippet}
            </pre>
          </div>
        </details>
      )}

      {/* Violations Summary */}
      {hasViolations && (
        <details className="group">
          <summary className="flex items-center gap-1.5 text-destructive cursor-pointer list-none">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            <AlertCircle className="h-3.5 w-3.5" />
            <span className="font-medium">
              {violations.length} blocked request
              {violations.length !== 1 ? "s" : ""}
            </span>
          </summary>
          <div className="mt-2 space-y-1 max-h-32 overflow-auto pl-5">
            {violations.map((v, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
              >
                <Badge
                  variant="outline"
                  className="text-[9px] px-1 py-0 h-4 shrink-0"
                >
                  {v.effectiveDirective || v.directive}
                </Badge>
                <span className="font-mono truncate">
                  {v.blockedUri || "(inline)"}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Widget's Declared CSP */}
      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">
            connect_domains
          </Label>
          <div className="text-[10px]">
            {currentMode === "permissive" ? (
              <span className="text-muted-foreground italic">
                Not enforced in permissive mode
              </span>
            ) : declaredConnectDomains.length > 0 ? (
              <div className="font-mono space-y-0.5">
                {declaredConnectDomains.map((d, i) => (
                  <div key={i} className="truncate">
                    {d}
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground italic">Not declared</span>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">
            resource_domains
          </Label>
          <div className="text-[10px]">
            {currentMode === "permissive" ? (
              <span className="text-muted-foreground italic">
                Not enforced in permissive mode
              </span>
            ) : declaredResourceDomains.length > 0 ? (
              <div className="font-mono space-y-0.5">
                {declaredResourceDomains.map((d, i) => (
                  <div key={i} className="truncate">
                    {d}
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground italic">Not declared</span>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">
            {protocol === "openai-apps" ? "frame_domains" : "frameDomains"}
          </Label>
          <div className="text-[10px]">
            {currentMode === "permissive" ? (
              <span className="text-muted-foreground italic">
                Not enforced in permissive mode
              </span>
            ) : declaredFrameDomains.length > 0 ? (
              <div className="font-mono space-y-0.5">
                {declaredFrameDomains.map((d, i) => (
                  <div key={i} className="truncate">
                    {d}
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground italic">Not declared</span>
            )}
          </div>
        </div>

        {protocol === "mcp-apps" && (
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">
              baseUriDomains
            </Label>
            <div className="text-[10px]">
              {currentMode === "permissive" ? (
                <span className="text-muted-foreground italic">
                  Not enforced in permissive mode
                </span>
              ) : declaredBaseUriDomains.length > 0 ? (
                <div className="font-mono space-y-0.5">
                  {declaredBaseUriDomains.map((d, i) => (
                    <div key={i} className="truncate">
                      {d}
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-muted-foreground italic">
                  Not declared
                </span>
              )}
            </div>
          </div>
        )}
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
        href={
          protocol === "mcp-apps"
            ? "https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx#ui-resource-format"
            : "https://developers.openai.com/apps-sdk/reference/#component-resource-configuration"
        }
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
      >
        <ExternalLink className="h-3 w-3" />
        {protocol === "mcp-apps"
          ? "MCP Apps UI format docs"
          : "openai/widgetCSP docs"}
      </a>
    </div>
  );
}
