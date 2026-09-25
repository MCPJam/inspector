import { useState } from "react";

function faviconSrc(host: string): string {
  const domain = host.replace(/^mcp\./, "");
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

export function ScoreServerMark({ host }: { host: string }) {
  const [failed, setFailed] = useState(false);
  const letter = host.slice(0, 1).toUpperCase() || "?";

  if (failed) {
    return (
      <span className="flex h-8 w-8 items-center justify-center rounded-sm border border-[var(--score-border)] bg-[var(--score-surface)] text-sm font-semibold text-[var(--score-fg)]">
        {letter}
      </span>
    );
  }

  return (
    <span className="flex h-8 w-8 overflow-hidden rounded-sm border border-[var(--score-border)] bg-[var(--score-fg)]">
      <img
        alt=""
        src={faviconSrc(host)}
        width={32}
        height={32}
        className="h-full w-full object-contain"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
