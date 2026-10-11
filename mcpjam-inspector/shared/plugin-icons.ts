import { IconSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const iconSchema = z.strictObject({
  src: z.string().max(128 * 1024),
  theme: z.enum(["light", "dark"]).optional(),
  mimeType: z.literal("image/svg+xml").optional(),
});
export const pluginIconMetadataSchema = z.strictObject({
  toolIcons: z.array(iconSchema).max(32),
  serverIcons: z.array(iconSchema).max(32),
});
export type PluginIconMetadata = z.infer<typeof pluginIconMetadataSchema>;

function normalizeIcons(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 32).flatMap((value) => {
    const parsed = IconSchema.safeParse(value);
    if (!parsed.success) return [];
    const { theme } = parsed.data;
    const src = imageSource(parsed.data.src);
    const svg =
      parsed.data.mimeType === "image/svg+xml" ||
      /^data:image\/svg\+xml[;,]/i.test(src ?? "") ||
      (src &&
        !src.startsWith("data:") &&
        new URL(src).pathname.toLowerCase().endsWith(".svg"));
    return src
      ? [
          {
            src,
            ...(theme ? { theme } : {}),
            ...(svg ? { mimeType: "image/svg+xml" as const } : {}),
          },
        ]
      : [];
  });
}

/** Only bounded icon presentation crosses the admitted catalog boundary. */
export function pluginIconMetadata(
  toolIcons: unknown,
  serverIcons: unknown,
): PluginIconMetadata {
  return {
    toolIcons: normalizeIcons(toolIcons),
    serverIcons: normalizeIcons(serverIcons),
  };
}

export type PluginIconCandidate = {
  src: string;
  source: "tool" | "server";
  svg: boolean;
};

/** Advisory images only; never insert server SVG markup into the host document. */
function imageSource(value: string): string | undefined {
  if (value.length > 128 * 1024 || /[\u0000-\u0020\u007f]/.test(value))
    return undefined;
  if (
    /^data:image\/(svg\+xml|png|jpeg|gif|webp)(?:;base64,|;charset=utf-8,|,)/i.test(
      value,
    )
  )
    return value;
  if (value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Tool → server → generic (the caller renders generic after image failures). */
export function pluginIconCandidates({
  toolIcons,
  serverIcons,
  theme,
}: {
  toolIcons?: unknown;
  serverIcons?: unknown;
  theme: "light" | "dark";
}): PluginIconCandidate[] {
  const seen = new Set<string>();
  return (
    [
      ["tool", toolIcons],
      ["server", serverIcons],
    ] as const
  ).flatMap(([source, input]) => {
    if (!Array.isArray(input)) return [];
    const icons = normalizeIcons(input).filter(
      (icon) => !icon.theme || icon.theme === theme,
    );
    return [
      ...icons.filter((icon) => icon.theme === theme),
      ...icons.filter((icon) => !icon.theme),
    ]
      .slice(0, 8)
      .flatMap(({ src, mimeType }) => {
        if (seen.has(src)) return [];
        seen.add(src);
        return [{ src, source, svg: mimeType === "image/svg+xml" }];
      });
  });
}
