/** Bound a policy envelope without loading runtime SDK services. */
export const MAX_SEALED_PLAINTEXT_BYTES = 8 * 1024;

/** The proxy URL parameter carrying a server's tool-catalog version. It lives
 *  here so the baked bridge patch can name it without loading runtime code. */
export const HARNESS_TOOL_CATALOG_QUERY = "mcpjam_tools";
