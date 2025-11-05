import { memo, useMemo } from "react";
import type {
  OAuthProtocolVersion,
  OAuthFlowState,
} from "@/lib/oauth/state-machines/types";
import { OAuthSequenceDiagramContent } from "@/components/oauth/shared/OAuthSequenceDiagramContent";
import { buildActions_2025_11_25 } from "@/lib/oauth/state-machines/debug-oauth-2025-11-25";
import { buildActions_2025_06_18 } from "@/lib/oauth/state-machines/debug-oauth-2025-06-18";
import { buildActions_2025_03_26 } from "@/lib/oauth/state-machines/debug-oauth-2025-03-26";

interface OAuthSequenceDiagramProps {
  flowState: OAuthFlowState;
  registrationStrategy?: "cimd" | "dcr" | "preregistered";
  protocolVersion?: OAuthProtocolVersion;
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
    <OAuthSequenceDiagramContent flowState={flowState} actions={actions} />
  );
});

OAuthSequenceDiagram.displayName = "OAuthSequenceDiagram";
