import type { ReactNode } from "react";
import {
  ScorePreviewCard,
  type ScorePreviewStage,
} from "./ScorePreviewCard";
import { ScoreWordmark } from "./ScoreWordmark";
import "./score-site.css";

const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&family=Montserrat:wght@800&display=swap";

export function ScoreSiteShell({
  children,
  compactPreview = false,
  previewStage = "card",
  preview = "example",
}: {
  children: ReactNode;
  compactPreview?: boolean;
  previewStage?: ScorePreviewStage;
  preview?: "example" | "none";
}) {
  const pageLayout = preview === "none";

  return (
    <div className="score-site relative isolate flex min-h-dvh w-full flex-col overflow-x-clip antialiased xl:h-dvh xl:min-h-[700px] xl:overflow-y-auto">
      <link rel="stylesheet" href={FONT_HREF} />
      {preview === "example" && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden"
        >
          <div className="score-site-glow absolute bottom-0 h-[120px] w-[1440px] bg-[#030303]">
            <div className="score-site-orb score-site-orb--bloom absolute left-[816px] top-[-60px] h-[720px] w-[720px] rounded-full bg-[#EE362F38]" />
            <div className="score-site-orb score-site-orb--ember absolute left-[644px] top-[15px] h-[420px] w-[420px] rounded-full bg-[#E0785659]" />
          </div>
        </div>
      )}

      <header className="relative z-10 flex h-[54px] shrink-0 items-center px-6 pt-8 md:px-12">
        <ScoreWordmark />
      </header>

      <div
        className={`score-site-layout relative z-10 flex w-full flex-1 flex-col gap-12 px-6 py-12 md:px-12 ${
          pageLayout ? "score-site-layout--page" : ""
        }`}
      >
        <div className="score-site-content min-w-0">{children}</div>
        {preview === "example" && (
          <ScorePreviewCard compact={compactPreview} stage={previewStage} />
        )}
      </div>
    </div>
  );
}
