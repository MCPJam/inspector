import {
  buildActions_2025_03_26,
} from "./state-machines/debug-oauth-2025-03-26.js";
import {
  buildActions_2025_06_18,
} from "./state-machines/debug-oauth-2025-06-18.js";
import {
  buildActions_2025_11_25,
} from "./state-machines/debug-oauth-2025-11-25.js";
import type {
  OAuthFlowState,
  OAuthProtocolVersion,
  RegistrationStrategy2025_03_26,
  RegistrationStrategy2025_06_18,
  RegistrationStrategy2025_11_25,
} from "./state-machines/types.js";
import type { DiagramAction } from "./state-machines/shared/types.js";

type OAuthSequenceActionInput = {
  protocolVersion: OAuthProtocolVersion;
  registrationStrategy:
    | RegistrationStrategy2025_03_26
    | RegistrationStrategy2025_06_18
    | RegistrationStrategy2025_11_25;
  flowState: OAuthFlowState;
};

export function buildOAuthSequenceActions({
  protocolVersion,
  registrationStrategy,
  flowState,
}: OAuthSequenceActionInput): DiagramAction[] {
  switch (protocolVersion) {
    case "2025-03-26":
      return buildActions_2025_03_26(
        flowState,
        registrationStrategy === "cimd" ? "dcr" : registrationStrategy,
      );
    case "2025-06-18":
      return buildActions_2025_06_18(
        flowState,
        registrationStrategy === "cimd" ? "dcr" : registrationStrategy,
      );
    case "2025-11-25":
      return buildActions_2025_11_25(flowState, registrationStrategy);
    default: {
      const _exhaustive: never = protocolVersion;
      throw new Error(`Unknown protocol version: ${_exhaustive}`);
    }
  }
}
