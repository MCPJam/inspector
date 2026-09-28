/** Admission facts for a locally executed call; never contains prompt or tool data. */
export type ModelWorkload = {
  purpose: "chat" | "evalTarget";
  hasTools: boolean;
  hasUserImages: boolean;
};

export function modelWorkloadFor(args: {
  sourceType: string;
  tools?: unknown;
  messages?: unknown;
}): ModelWorkload {
  const imagePart = (part: unknown): boolean => {
    if (!part || typeof part !== "object") return false;
    const { type, mediaType, mimeType } = part as Record<string, unknown>;
    const media = typeof mediaType === "string" ? mediaType : mimeType;
    return (
      type === "image" ||
      (type === "file" &&
        typeof media === "string" &&
        media.startsWith("image/"))
    );
  };
  return {
    purpose:
      args.sourceType === "direct" || args.sourceType === "chat"
        ? "chat"
        : "evalTarget",
    hasTools:
      !!args.tools &&
      typeof args.tools === "object" &&
      Object.keys(args.tools).length > 0,
    hasUserImages:
      Array.isArray(args.messages) &&
      args.messages.some((message: unknown) => {
        if (!message || typeof message !== "object") return false;
        const { role, content, parts } = message as Record<string, unknown>;
        return (
          role === "user" &&
          ((Array.isArray(content) && content.some(imagePart)) ||
            (Array.isArray(parts) && parts.some(imagePart)))
        );
      }),
  };
}
