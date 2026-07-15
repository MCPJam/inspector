import {
  XAA_CONFIDENTIAL_CIMD_ORIGIN,
  buildConfidentialCimdUrl,
} from "../oauth/client-identity.js";
import { signClientAssertion } from "./mint/client-assertion.js";
import {
  getXaaClientJwks,
  initXaaClientKeyPair,
} from "./mint/client-keypair.js";
import {
  buildJwtBearerRequest,
  type XaaTokenEndpointAuthMethod,
} from "./mint/jwt-bearer.js";

/**
 * Node-only credential boundary for confidential CIMD. Consumers can share the
 * XAA protocol engine without learning how the private key is loaded or stored.
 */
export interface ConfidentialCimdProvider {
  getClientIdMetadataUrl(origin?: string): string;
  signClientAssertion(args: {
    clientId: string;
    tokenEndpoint: string;
  }): string;
}

let localProvider: ConfidentialCimdProvider | undefined;

/**
 * Return the process-local confidential-CIMD provider used by the CLI and the
 * local inspector server. Key initialization remains lazy: merely constructing
 * a router or parsing CLI arguments never creates key material.
 */
export function getLocalConfidentialCimdProvider(): ConfidentialCimdProvider {
  localProvider ??= {
    getClientIdMetadataUrl(origin = XAA_CONFIDENTIAL_CIMD_ORIGIN): string {
      initXaaClientKeyPair();
      return buildConfidentialCimdUrl(getXaaClientJwks().keys[0], origin);
    },
    signClientAssertion(args): string {
      initXaaClientKeyPair();
      return signClientAssertion(args);
    },
  };
  return localProvider;
}

export interface BuildXaaJwtBearerRequestArgs {
  assertion: string;
  tokenEndpoint: string;
  clientId?: string | null;
  clientSecret?: string | null;
  scope?: string | null;
  resource?: string | null;
  tokenEndpointAuthMethod?: XaaTokenEndpointAuthMethod | null;
}

/**
 * Build the complete RAS redemption request, including private_key_jwt when
 * selected. This is the shared Node-side seam used by both the CLI executor and
 * the inspector server proxy; browser code carries only the method and client
 * id, never the credential.
 */
export function buildXaaJwtBearerRequest(
  args: BuildXaaJwtBearerRequestArgs,
  confidentialCimdProvider?: ConfidentialCimdProvider
): { headers: Record<string, string>; body: Record<string, string> } {
  let clientAssertion: string | undefined;
  if (args.tokenEndpointAuthMethod === "private_key_jwt") {
    if (!args.clientId) {
      throw new Error("private_key_jwt requires a client_id");
    }
    if (!confidentialCimdProvider) {
      throw new Error(
        "private_key_jwt is unavailable because no confidential CIMD provider is configured"
      );
    }
    clientAssertion = confidentialCimdProvider.signClientAssertion({
      clientId: args.clientId,
      tokenEndpoint: args.tokenEndpoint,
    });
  }

  return buildJwtBearerRequest({
    assertion: args.assertion,
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    scope: args.scope,
    resource: args.resource,
    tokenEndpointAuthMethod: args.tokenEndpointAuthMethod,
    clientAssertion,
  });
}
