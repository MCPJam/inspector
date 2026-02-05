import { memo, useMemo } from "react";
import type {
  OAuthProtocolVersion,
  OAuthFlowState,
  OAuthFlowStep,
} from "@/lib/oauth/state-machines/types";
import { OAuthSequenceDiagramContent } from "@/components/oauth/shared/OAuthSequenceDiagramContent";
import { buildActions_2025_11_25 } from "@/lib/oauth/state-machines/debug-oauth-2025-11-25";
import { buildActions_2025_06_18 } from "@/lib/oauth/state-machines/debug-oauth-2025-06-18";
import { buildActions_2025_03_26 } from "@/lib/oauth/state-machines/debug-oauth-2025-03-26";
import { Button } from "@/components/ui/button";
import { Settings } from "lucide-react";

interface OAuthSequenceDiagramProps {
  flowState: OAuthFlowState;
  registrationStrategy?: "cimd" | "dcr" | "preregistered";
  protocolVersion?: OAuthProtocolVersion;
  focusedStep?: OAuthFlowStep | null;
  hasProfile?: boolean;
  onConfigure?: () => void;
}

/**
 * Factory component that selects the appropriate OAuth actions builder
 * based on the protocol version and renders the sequence diagram.
 *
 * Actions are co-located with their state machine files for easy maintenance
 * and to ensure step IDs match between business logic and visualization.
 */
export const OAuthSequenceDiagram = memo((props: OAuthSequenceDiagramProps) => {
  const {
    flowState,
    registrationStrategy = "dcr",
    protocolVersion = "2025-11-25",
    focusedStep,
    hasProfile = true,
    onConfigure,
  } = props;

  // Select the appropriate actions builder based on protocol version
  const actions = useMemo(() => {
    switch (protocolVersion) {
      case "2025-11-25":
        return buildActions_2025_11_25(flowState, registrationStrategy);

      case "2025-06-18":
        // 2025-06-18 doesn't support CIMD, fallback to DCR
        return buildActions_2025_06_18(
          flowState,
          registrationStrategy === "cimd" ? "dcr" : registrationStrategy,
        );

      case "2025-03-26":
        // 2025-03-26 doesn't support CIMD, fallback to DCR
        return buildActions_2025_03_26(
          flowState,
          registrationStrategy === "cimd" ? "dcr" : registrationStrategy,
        );

      default:
        console.warn(
          `Unknown protocol version: ${protocolVersion}. Defaulting to 2025-11-25.`,
        );
        return buildActions_2025_11_25(flowState, registrationStrategy);
    }
  }, [protocolVersion, flowState, registrationStrategy]);

  return (
    <div className="relative h-full w-full">
      <div
        className={
          hasProfile
            ? "h-full w-full"
            : "h-full w-full opacity-30 pointer-events-none"
        }
      >
        <OAuthSequenceDiagramContent
          flowState={flowState}
          actions={actions}
          focusedStep={focusedStep ?? undefined}
        />
      </div>

      {!hasProfile && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="bg-background border border-border rounded-lg shadow-lg p-8 max-w-md text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
              <Settings className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">
              Configure OAuth Target
            </h3>
            <p className="text-sm text-muted-foreground mb-6">
              Enter an MCP server URL to start debugging the OAuth
              authentication flow step-by-step.
            </p>
            {onConfigure && (
              <Button onClick={onConfigure} size="lg">
                Configure Target
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

OAuthSequenceDiagram.displayName = "OAuthSequenceDiagram";
