import {
  XAA_CONFIDENTIAL_CIMD_ORIGIN,
  buildConfidentialCimdUrl,
} from "../oauth/client-identity.js";
import {
  signClientAssertion,
  signClientAssertionWithKey,
} from "./mint/client-assertion.js";
import { deriveOrgConfidentialCimdKey } from "./mint/derived-client-key.js";
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

/**
 * Build stateless, organization-bound confidential-CIMD providers from one
 * deployment master key. Callers must authorize an organization before asking
 * the factory for its provider; the provider itself still refuses to sign for
 * any other client_id.
 */
export function createDerivedConfidentialCimdProviderFactory(
  masterKey: Uint8Array,
): (organizationId: string) => ConfidentialCimdProvider {
  // Validate eagerly so a configured but malformed deployment secret fails at
  // startup rather than during a user's token redemption.
  if (Buffer.from(masterKey).length !== 32) {
    throw new Error(
      "XAA confidential CIMD master key must contain exactly 32 bytes",
    );
  }
  const stableMasterKey = Buffer.from(masterKey);

  return (organizationId: string): ConfidentialCimdProvider => {
    const { privateKey, publicJwk } = deriveOrgConfidentialCimdKey(
      stableMasterKey,
      organizationId,
    );
    const expectedClientId = buildConfidentialCimdUrl(publicJwk);

    return {
      getClientIdMetadataUrl(origin = XAA_CONFIDENTIAL_CIMD_ORIGIN): string {
        return buildConfidentialCimdUrl(publicJwk, origin);
      },
      signClientAssertion(args): string {
        if (args.clientId !== expectedClientId) {
          throw new Error(
            "confidential CIMD client_id does not match the organization-bound client key",
          );
        }
        return signClientAssertionWithKey(args, privateKey);
      },
    };
  };
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
