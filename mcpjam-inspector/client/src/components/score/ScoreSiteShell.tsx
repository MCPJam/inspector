import type { ReactNode } from "react";
import { ScorePreviewCard } from "./ScorePreviewCard";
import { ScoreWordmark } from "./ScoreWordmark";
import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/instrument-sans/600.css";
import "@fontsource/montserrat/800.css";
import "./score-site.css";

export function ScoreSiteShell({
  children,
  compactPreview = false,
  atmosphere = "landing",
}: {
  children: ReactNode;
  compactPreview?: boolean;
  atmosphere?: "landing" | "email";
}) {
  const emailAtmosphere = atmosphere === "email";

  return (
    <div className="score-site relative isolate flex min-h-dvh w-full flex-col overflow-x-clip antialiased xl:h-dvh xl:min-h-[700px] xl:overflow-y-auto">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="score-site-glow absolute bottom-0 h-[120px] w-[1440px] bg-[#030303]">
          {emailAtmosphere ? (
            <div className="absolute left-[601px] top-[15px] h-[420px] w-[420px] rounded-full bg-[#E0785659]" />
          ) : (
            <>
              <div className="absolute left-[816px] top-[-60px] h-[720px] w-[720px] rounded-full bg-[#EE362F38]" />
              <div className="absolute left-[644px] top-[15px] h-[420px] w-[420px] rounded-full bg-[#E0785659]" />
            </>
          )}
        </div>
        {emailAtmosphere && (
          <div className="score-site-email-glow absolute top-[646px] h-[720px] w-[720px] rounded-full bg-[#EE362F38]" />
        )}
      </div>

      <header className="relative z-10 flex h-[54px] shrink-0 items-center px-6 pt-8 md:px-12">
        <ScoreWordmark />
      </header>

      <div className="score-site-layout relative z-10 flex w-full flex-1 flex-col gap-12 px-6 py-12 md:px-12">
        <div className="score-site-content min-w-0">{children}</div>
        <ScorePreviewCard compact={compactPreview} />
      </div>
    </div>
  );
}
