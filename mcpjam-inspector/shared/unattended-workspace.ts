/** Host presentation only. These values never authorize execution or affect a bridge. */
export interface HarnessPresentation {
  theme?: "light" | "dark";
  hostStyle?: string;
  messages?: Array<
    { role: "user" | "assistant"; text: string } | { role: "app" }
  >;
}

/** Project model history to inert text. Never retain tool payloads, images, or URLs. */
export function projectWorkspaceTranscript(
  history: readonly unknown[],
  hostContext?: unknown,
  hostConfig?: { hostStyle?: unknown } | null,
): HarnessPresentation {
  const messages: NonNullable<HarnessPresentation["messages"]> = [];
  for (const item of history.slice(-100)) {
    if (!item || typeof item !== "object") continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant" && role !== "tool") continue;
    if (role === "tool") {
      messages.push({ role: "app" });
      continue;
    }
    if (typeof content === "string") {
      messages.push({ role, text: content.slice(0, 8192) });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .slice(0, 8192);
    if (text) messages.push({ role, text });
    if (
      content.some(
        (part) => part?.type === "tool-call" || part?.type === "tool-result",
      )
    )
      messages.push({ role: "app" });
  }
  const theme =
    hostContext && typeof hostContext === "object"
      ? (hostContext as { theme?: unknown }).theme
      : undefined;
  return {
    messages: messages.slice(-100),
    ...(typeof hostConfig?.hostStyle === "string"
      ? { hostStyle: hostConfig.hostStyle }
      : {}),
    ...(theme === "light" || theme === "dark" ? { theme } : {}),
  };
}

/** Presentation follows field precedence, not whole-object replacement. */
export function workspacePresentationHostConfig(
  base?: Record<string, unknown> | null,
  override?: Record<string, unknown> | null,
) {
  return { ...base, ...override };
}
