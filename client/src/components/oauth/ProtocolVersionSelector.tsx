/**
 * Protocol Version Selector Component
 * Allows switching between 2025-06-18 (Stable) and 2025-11-25 (Draft) OAuth protocols
 */

import { Info, CheckCircle2, AlertCircle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import {
  OAuthProtocolVersion,
  PROTOCOL_VERSION_INFO,
  getSupportedRegistrationStrategies,
} from "@/lib/debug-oauth-state-machine";

interface ProtocolVersionSelectorProps {
  value: OAuthProtocolVersion;
  onChange: (version: OAuthProtocolVersion) => void;
  registrationStrategy?: string;
  onRegistrationStrategyChange?: (strategy: string) => void;
  disabled?: boolean;
  showDetails?: boolean;
}

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
              Choose between stable and draft specifications
            </CardDescription>
          </div>
          {value === "2025-11-25" && (
            <Badge variant="default" className="ml-2">
              Latest
            </Badge>
          )}
          {value === "2025-06-18" && (
            <Badge variant="secondary" className="ml-2">
              Stable
            </Badge>
          )}
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
              <SelectItem value="2025-06-18">
                <div className="flex items-center gap-2">
                  <span>2025-06-18</span>
                  <Badge variant="secondary" className="text-xs">
                    Stable
                  </Badge>
                </div>
              </SelectItem>
              <SelectItem value="2025-11-25">
                <div className="flex items-center gap-2">
                  <span>2025-11-25</span>
                  <Badge variant="default" className="text-xs">
                    Draft
                  </Badge>
                </div>
              </SelectItem>
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
                {value === "2025-11-25" ? (
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
      {value === "2025-11-25" && (
        <Badge variant="default" className="text-xs px-1.5 py-0">
          Draft
        </Badge>
      )}
      {value === "2025-06-18" && (
        <Badge variant="secondary" className="text-xs px-1.5 py-0">
          Stable
        </Badge>
      )}
    </Button>
  );
}
