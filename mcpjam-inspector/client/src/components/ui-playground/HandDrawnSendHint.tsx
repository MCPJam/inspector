import { useMemo } from "react";
import { getChatboxHostFamily } from "@/lib/chatbox-host-style";
import { cn } from "@/lib/utils";
import arrow8Svg from "./arrow-8.svg?raw";

const HINT_LABEL = "Try this prompt with a demo MCP server";

const hintFontStyle = {
  fontFamily: "'Caveat', cursive",
  fontWeight: 600 as const,
};

function arrow8Markup(inkColor: string): { __html: string } {
  const svgClass = cn(
    "mr-0 -mb-1 block h-auto w-[5.25rem] max-w-full -translate-x-6 translate-y-1.5 overflow-visible",
    inkColor,
  );
  let html = arrow8Svg.trim();
  html = html.replace(
    /^<svg\s+/,
    `<svg class="${svgClass}" aria-hidden="true" `,
  );
  return { __html: html };
}

interface HandDrawnSendHintProps {
  hostStyle?: string;
  theme?: "light" | "dark";
}

/**
 * Whimsical arrow + handwriting annotation that nudges first-time users
 * toward the Send button. Arrow graphic is `arrow-8.svg`.
 */
export function HandDrawnSendHint({
  hostStyle,
  theme = "light",
}: HandDrawnSendHintProps) {
  const hostFamily = getChatboxHostFamily(hostStyle);
  const inkColor =
    hostFamily === "chatgpt"
      ? theme === "dark"
        ? "text-neutral-400"
        : "text-neutral-500"
      : theme === "dark"
        ? "text-[#c4a882]"
        : "text-[#6b5e50]";

  const textColor =
    hostFamily === "chatgpt"
      ? theme === "dark"
        ? "text-neutral-300"
        : "text-neutral-600"
      : theme === "dark"
        ? "text-[#d4c4a8]"
        : "text-[#5a4f42]";

  const arrowHtml = useMemo(() => arrow8Markup(inkColor), [inkColor]);

  return (
    <div
      className="relative mt-1 flex w-full justify-end px-4"
      role="note"
      aria-live="polite"
    >
      <div
        className="flex flex-col items-end gap-0"
        data-testid="app-builder-send-nux-hint"
      >
        <span
          className="inline-block"
          aria-hidden
          dangerouslySetInnerHTML={arrowHtml}
        />

        <p
          className={cn(
            "mr-6 mt-2 max-w-none -translate-x-6 whitespace-nowrap text-right text-[19px] leading-snug select-none",
            textColor,
          )}
          style={hintFontStyle}
        >
          {HINT_LABEL}
        </p>
      </div>
    </div>
  );
}
