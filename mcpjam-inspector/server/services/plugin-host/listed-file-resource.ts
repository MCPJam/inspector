import { createHash } from "node:crypto";
import type { MCPClientManager } from "@mcpjam/sdk";
import { ResourceGrantError, type ResourceVersion } from "./resource-grants.js";

/** Only a current listing from the admitted saved server may grant an initial file. */
export async function resolveListedFileResource(
  manager: Pick<MCPClientManager, "listResources">,
  serverId: string,
  uri: string,
  signal: AbortSignal,
) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 64; page++) {
    signal.throwIfAborted();
    const listed = await manager.listResources(
      serverId,
      cursor ? { cursor } : undefined,
      { signal, cacheMode: "bypass" },
    );
    signal.throwIfAborted();
    const matches = listed.resources.filter((resource) => resource.uri === uri);
    if (matches.length > 1) throw new ResourceGrantError("RESOURCE_INVALID");
    if (matches.length === 1) {
      const { name } = matches[0];
      if (
        !name.trim() ||
        name.length > 255 ||
        /[/\\\u0000-\u001f]/u.test(name) ||
        name === "." ||
        name === ".."
      )
        throw new ResourceGrantError("RESOURCE_INVALID");
      return { uri, name };
    }
    if (!listed.nextCursor) break;
    if (seen.has(listed.nextCursor))
      throw new ResourceGrantError("RESOURCE_INVALID");
    seen.add(listed.nextCursor);
    cursor = listed.nextCursor;
  }
  throw new ResourceGrantError("RESOURCE_DENIED");
}

export function readListedFileBytes(
  result: Awaited<ReturnType<MCPClientManager["readResource"]>>,
  uri: string,
): ResourceVersion {
  const matches = result.contents.filter((content) => content.uri === uri);
  if (matches.length !== 1) throw new ResourceGrantError("RESOURCE_INVALID");
  const content = matches[0];
  let bytes: Uint8Array;
  if ("text" in content && typeof content.text === "string")
    bytes = new TextEncoder().encode(content.text);
  else if (
    "blob" in content &&
    typeof content.blob === "string" &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      content.blob,
    )
  )
    bytes = Buffer.from(content.blob, "base64");
  else throw new ResourceGrantError("RESOURCE_INVALID");
  if (bytes.byteLength > 1024 * 1024)
    throw new ResourceGrantError("RESOURCE_TOO_LARGE");
  return {
    bytes,
    mimeType: content.mimeType,
    etag: createHash("sha256").update(bytes).digest("hex"),
  };
}
