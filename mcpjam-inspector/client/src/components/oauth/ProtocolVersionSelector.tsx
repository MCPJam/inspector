/**
 * Protocol Version Selector Component
 */

import { Info, CheckCircle2, AlertCircle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@mcpjam/design-system/card";
import { Label } from "@mcpjam/design-system/label";
import { Alert, AlertDescription } from "@mcpjam/design-system/alert";
import { Badge } from "@mcpjam/design-system/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { Button } from "@mcpjam/design-system/button";
import { useState } from "react";
import {
  PROTOCOL_VERSION_INFO,
  getSupportedRegistrationStrategies,
  type OAuthProtocolVersion,
} from "@mcpjam/sdk/browser";

interface ProtocolVersionSelectorProps {
  value: OAuthProtocolVersion;
  onChange: (version: OAuthProtocolVersion) => void;
  registrationStrategy?: string;
  onRegistrationStrategyChange?: (strategy: string) => void;
  disabled?: boolean;
  showDetails?: boolean;
}

const SELECTABLE_PROTOCOL_VERSIONS: OAuthProtocolVersion[] = [
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
];

export function ProtocolVersionSelector({
  value,
  onChange,
  registrationStrategy,
  onRegistrationStrategyChange,
  disabled = false,
  showDetails = true,
}: ProtocolVersionSelectorProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const currentInfo = PROTOCOL_VERSION_INFO[value];
  const supportedStrategies = getSupportedRegistrationStrategies(value);

  // Check if current registration strategy is supported by selected protocol
  const isStrategySupported =
    !registrationStrategy || supportedStrategies.includes(registrationStrategy);

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">OAuth Protocol Version</CardTitle>
            <CardDescription>
              Choose an MCP OAuth specification version
            </CardDescription>
          </div>
          <Badge
            variant={currentInfo.status === "Latest" ? "default" : "secondary"}
            className="ml-2"
          >
            {currentInfo.status}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Protocol Version Selector */}
        <div className="space-y-2">
          <Label htmlFor="protocol-version">Protocol Version</Label>
          <Select value={value} onValueChange={onChange} disabled={disabled}>
            <SelectTrigger id="protocol-version">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SELECTABLE_PROTOCOL_VERSIONS.map((version) => {
                const info = PROTOCOL_VERSION_INFO[version];
                return (
                  <SelectItem key={version} value={version}>
                    <div className="flex items-center gap-2">
                      <span>{version}</span>
                      <Badge
                        variant={
                          info.status === "Latest" ? "default" : "secondary"
                        }
                        className="text-xs"
                      >
                        {info.status}
                      </Badge>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        {/* Registration Strategy Selector */}
        {onRegistrationStrategyChange && (
          <div className="space-y-2">
            <Label htmlFor="registration-strategy">Registration Strategy</Label>
            <Select
              value={registrationStrategy}
              onValueChange={onRegistrationStrategyChange}
              disabled={disabled}
            >
              <SelectTrigger id="registration-strategy">
                <SelectValue placeholder="Select strategy..." />
              </SelectTrigger>
              <SelectContent>
                {supportedStrategies.map((strategy) => (
                  <SelectItem key={strategy} value={strategy}>
                    <div className="flex items-center gap-2">
                      <span className="capitalize">
                        {strategy === "cimd"
                          ? "Client ID Metadata Documents (CIMD)"
                          : strategy === "dcr"
                            ? "Dynamic Client Registration (DCR)"
                            : "Pre-registered"}
                      </span>
                      {value === "2025-11-25" && strategy === "cimd" && (
                        <Badge variant="default" className="text-xs">
                          Recommended
                        </Badge>
                      )}
                      {value === "2025-06-18" && strategy === "dcr" && (
                        <Badge variant="secondary" className="text-xs">
                          Recommended
                        </Badge>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {!isStrategySupported && registrationStrategy && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <strong>{registrationStrategy.toUpperCase()}</strong> is not
                  supported in {value}. Please select a different strategy.
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {/* Protocol Info */}
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">
            <div className="font-medium mb-1">{currentInfo.description}</div>
          </AlertDescription>
        </Alert>

        {/* Protocol Details - Collapsible */}
        {showDetails && (
          <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full">
                {detailsOpen ? "Hide" : "Show"} Protocol Features
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              <div className="rounded-md border p-3 space-y-2">
                {currentInfo.features.map((feature, index) => (
                  <div key={index} className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                    <span className="text-muted-foreground">{feature}</span>
                  </div>
                ))}
              </div>

              {/* Key Differences */}
              <div className="text-xs text-muted-foreground mt-2 p-2 bg-muted/50 rounded">
                {value === "2026-07-28" ? (
                  <div>
                    <strong>New in 2026-07-28:</strong>
                    <ul className="list-disc list-inside mt-1 space-y-0.5">
                      <li>
                        Inherits 2025-11-25 discovery, CIMD, and strict PKCE
                      </li>
                      <li>
                        OIDC <code>application_type</code> sent on Dynamic Client
                        Registration (SEP-837)
                      </li>
                    </ul>
                  </div>
                ) : value === "2025-11-25" ? (
                  <div>
                    <strong>New in 2025-11-25:</strong>
                    <ul className="list-disc list-inside mt-1 space-y-0.5">
                      <li>
                        Client ID Metadata Documents (CIMD) - Use HTTPS URLs as
                        client_id
                      </li>
                      <li>Strict PKCE verification (MUST support S256)</li>
                      <li>
                        Discovery path insertion priority (no root fallback)
                      </li>
                    </ul>
                  </div>
                ) : (
                  <div>
                    <strong>2025-06-18 Characteristics:</strong>
                    <ul className="list-disc list-inside mt-1 space-y-0.5">
                      <li>
                        Dynamic Client Registration (DCR) as primary method
                      </li>
                      <li>PKCE recommended but not strictly enforced</li>
                      <li>Discovery includes root endpoint fallback</li>
                    </ul>
                  </div>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Compact version for use in headers/toolbars
 */
export function ProtocolVersionBadge({
  value,
  onClick,
}: {
  value: OAuthProtocolVersion;
  onClick?: () => void;
}) {
  const currentInfo = PROTOCOL_VERSION_INFO[value];

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="gap-2"
      title={currentInfo.description}
    >
      <span className="text-xs font-mono">{value}</span>
      <Badge
        variant={currentInfo.status === "Latest" ? "default" : "secondary"}
        className="text-xs px-1.5 py-0"
      >
        {currentInfo.status}
      </Badge>
    </Button>
  );
}
