import type { MCPClientManager } from "../mcp-client-manager/MCPClientManager.js";
import {
  findOpenAIProfileTool,
  isOpenAIProfile,
  type OpenAIProfile,
} from "./profile.js";
export { findOpenAIProfileTool, isOpenAIProfile } from "./profile.js";
export type { OpenAIProfile } from "./profile.js";
export type OpenAIProfileCapture =
  | { profile: OpenAIProfile; structuredContent: boolean }
  | { profile: undefined; reason: string; structuredContent?: boolean };

/** One profile call, with a deadline covering discovery and invocation. */
export async function captureOpenAIProfile(
  manager: Pick<MCPClientManager, "listTools" | "executeTool">,
  key: string,
  { timeoutMs = 8_000 }: { timeoutMs?: number } = {}
): Promise<OpenAIProfileCapture> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (): Promise<OpenAIProfileCapture> => {
    const options = { signal: controller.signal, timeout: timeoutMs };
    const listing = await manager.listTools(key, undefined, options);
    const tool = findOpenAIProfileTool(listing.tools);
    if (!tool)
      return {
        profile: undefined,
        reason: "No unique profile tool is designated",
      };
    controller.signal.throwIfAborted();
    const result = await manager.executeTool(key, tool.name, {}, options);
    if (result.isError)
      return {
        profile: undefined,
        reason: "The profile tool returned an error",
      };
    const structuredContent = result.structuredContent !== undefined;
    let value = result.structuredContent;
    if (!structuredContent && Array.isArray(result.content)) {
      const text = result.content.find((item: any) => item.type === "text");
      if (text?.type === "text") value = JSON.parse(text.text);
    }
    return isOpenAIProfile(value)
      ? { profile: value, structuredContent }
      : {
          profile: undefined,
          reason: "The profile response does not satisfy the contract",
          structuredContent,
        };
  };
  try {
    return await Promise.race([
      run(),
      new Promise<OpenAIProfileCapture>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ profile: undefined, reason: "Profile capture timed out" });
        }, timeoutMs);
      }),
    ]);
  } catch {
    // Do not return upstream errors: they may contain credential-bearing URLs.
    return { profile: undefined, reason: "Profile capture failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
