/**
 * The web tier's public URL as this deployment configures it:
 * `MCPJAM_INSPECTOR_PUBLIC_URL`, else `BASE_URL`. A cloud sandbox dials the
 * harness MCP proxy there, and an authorization server fetches the XAA
 * issuer's discovery document from there, so both read this one definition.
 * Read at call time. Never derived from a request.
 */
export function configuredInspectorPublicUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    env.MCPJAM_INSPECTOR_PUBLIC_URL?.trim() || env.BASE_URL?.trim() || undefined
  );
}
