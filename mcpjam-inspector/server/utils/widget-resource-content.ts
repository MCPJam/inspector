import { readResourceDisplayHints } from "@mcpjam/sdk/widget-runtime";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import { resolveUiResourceMeta } from "./ui-resource-meta.js";

/** Shared representation handling; the caller owns resource admission. */
export function widgetResourceContent(
  content: unknown,
  listingMeta?: Record<string, unknown>,
) {
  if (!content || typeof content !== "object")
    throw new Error("No content in resource");
  const record = content as Record<string, unknown>;
  const html =
    typeof record.text === "string"
      ? record.text
      : typeof record.blob === "string"
      ? Buffer.from(record.blob, "base64").toString("utf-8")
      : "";
  if (!html) throw new Error("No HTML content in resource");
  const accepted = [RESOURCE_MIME_TYPE, "text/html+skybridge", "text/html"];
  const mimeTypeValid =
    typeof record.mimeType === "string" && accepted.includes(record.mimeType);
  const meta = resolveUiResourceMeta({
    contentMeta: record._meta as Record<string, unknown> | undefined,
    listingMeta,
  });
  return {
    html,
    resourceDisplayHints: readResourceDisplayHints(
      record._meta as Record<string, unknown> | undefined,
      listingMeta,
    ),
    csp: meta.csp,
    permissions: meta.permissions,
    prefersBorder: meta.prefersBorder,
    declaredDomain: meta.domain,
    metadataSource: meta.metadataSource,
    metadataSources: meta.metadataSources,
    mimeType: record.mimeType,
    mimeTypeValid,
    mimeTypeWarning: mimeTypeValid
      ? null
      : record.mimeType
      ? `Invalid mimetype "${
          record.mimeType
        }" - expected one of: ${accepted.join(", ")}`
      : `Missing mimetype - expected one of: ${accepted.join(", ")}`,
  };
}
