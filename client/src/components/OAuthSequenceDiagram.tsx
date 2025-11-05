import { memo, useMemo } from "react";
import type { OAuthProtocolVersion } from "@/lib/debug-oauth-state-machine";
import type { OAuthFlowState } from "@/lib/oauth/state-machines/types";
import { OAuthSequenceDiagramContent } from "./oauth/shared/OAuthSequenceDiagramContent";
import { buildActions_2025_11_25 } from "./oauth/diagrams/actions/actions_2025_11_25";
import { buildActions_2025_06_18 } from "./oauth/diagrams/actions/actions_2025_06_18";
import { buildActions_2025_03_26 } from "./oauth/diagrams/actions/actions_2025_03_26";

interface OAuthSequenceDiagramProps {
  flowState: OAuthFlowState;
  registrationStrategy?: "cimd" | "dcr" | "preregistered";
  protocolVersion?: OAuthProtocolVersion;
}

/**
 * Factory component that selects the appropriate OAuth actions builder
 * based on the protocol version and renders the sequence diagram.
 *
 * Each protocol version has its own actions builder file with protocol-specific
 * actions and behavior, ensuring clear 1:1 mapping with state machine files.
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
        return buildActions_2025_06_18(flowState, registrationStrategy);

      case "2025-03-26":
        return buildActions_2025_03_26(flowState, registrationStrategy);

      default:
        console.warn(
          `Unknown protocol version: ${protocolVersion}. Defaulting to 2025-11-25.`
        );
        return buildActions_2025_11_25(flowState, registrationStrategy);
    }
  }, [protocolVersion, flowState, registrationStrategy]);

  return <OAuthSequenceDiagramContent flowState={flowState} actions={actions} />;
});

OAuthSequenceDiagram.displayName = "OAuthSequenceDiagram";
