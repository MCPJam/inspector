import type { AppToolInvocationRecord } from "@mcpjam/widget-react";

export const APP_CLOSED_MESSAGE =
  "The app closed before the tool finished. Try again while the app is open in chat.";
export function appToolResult(raw: AppToolInvocationRecord["raw"]) {
  const parts = (raw.content ?? []).map((part) => {
    switch (part.type) {
      case "text":
        return part.text;
      case "resource":
        return `[resource: ${part.resource.uri}]`;
      case "resource_link":
        return `[resource: ${part.uri}]`;
      default:
        return `[${part.type}]`;
    }
  });
  if (raw.structuredContent !== undefined)
    parts.push(JSON.stringify(raw.structuredContent, null, 2));
  const text = parts.join("\n\n") || "The tool returned nothing.";
  const bytes = new TextEncoder().encode(text);
  return {
    ok: !raw.isError,
    text:
      bytes.length > 20 * 1024
        ? `${new TextDecoder().decode(bytes.slice(0, 20 * 1024))}\n\nShowing the first 20 KB.`
        : text,
  };
}
