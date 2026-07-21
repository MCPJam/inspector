import {
  createDerivedConfidentialCimdProviderFactory,
  type ConfidentialCimdProvider,
} from "@mcpjam/sdk";

/**
 * Parse the hosted-only master as exactly 32 random bytes encoded in unpadded
 * base64url. Unset disables derived confidential CIMD; a configured malformed
 * value is a deployment error and must fail before serving requests.
 */
export function readXaaCimdOrgMasterKey(
  raw: string | undefined = process.env.XAA_CIMD_ORG_MASTER_KEY
): Uint8Array | undefined {
  if (raw === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) {
    throw new Error(
      "XAA_CIMD_ORG_MASTER_KEY must be an unpadded base64url-encoded 32-byte secret"
    );
  }
  const decoded = Buffer.from(raw, "base64url");
  if (decoded.length !== 32) {
    throw new Error("XAA_CIMD_ORG_MASTER_KEY must decode to exactly 32 bytes");
  }
  if (Buffer.from(decoded).toString("base64url") !== raw) {
    throw new Error(
      "XAA_CIMD_ORG_MASTER_KEY must use canonical unpadded base64url encoding"
    );
  }
  return decoded;
}

type ConfidentialCimdProviderForOrg = (
  organizationId: string
) => ConfidentialCimdProvider;

let cachedRawMasterKey: string | undefined;
let cachedProviderForOrg: ConfidentialCimdProviderForOrg | undefined;
let hasResolvedProvider = false;

/**
 * Resolve the hosted provider only after startup has loaded Inspector dotenv
 * files. Keeping this behind a getter avoids snapshotting process.env during
 * ESM dependency evaluation, which happens before createHonoApp/index call
 * loadInspectorEnv().
 */
export function getConfidentialCimdProviderForOrg():
  | ConfidentialCimdProviderForOrg
  | undefined {
  const rawMasterKey = process.env.XAA_CIMD_ORG_MASTER_KEY;
  if (hasResolvedProvider && rawMasterKey === cachedRawMasterKey) {
    return cachedProviderForOrg;
  }

  const orgMasterKey = readXaaCimdOrgMasterKey(rawMasterKey);
  cachedRawMasterKey = rawMasterKey;
  cachedProviderForOrg = orgMasterKey
    ? createDerivedConfidentialCimdProviderFactory(orgMasterKey)
    : undefined;
  hasResolvedProvider = true;
  return cachedProviderForOrg;
}
