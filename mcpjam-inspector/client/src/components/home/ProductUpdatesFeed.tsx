import { Card } from "@mcpjam/design-system/card";
import { Newspaper } from "lucide-react";

interface ProductUpdate {
  date: string;
  title: string;
  body: string;
  tag?: string;
}

const UPDATES: ProductUpdate[] = [
  {
    date: "May 2026",
    title: "Stateless MCP (DRAFT-2026-v1)",
    body: "Configure per-server protocol mode for stateless HTTP MCP — three layers of control from org default to per-server override.",
    tag: "New",
  },
  {
    date: "May 2026",
    title: "Playground",
    body: "App Builder and Chat are now one tab. Build, preview, and test MCP-powered apps without switching views.",
  },
  {
    date: "Apr 2026",
    title: "MCP Apps SDK",
    body: "Build interactive UIs that live inside any MCP client. Register resources, handle messages, render rich views.",
  },
];

export function ProductUpdatesFeed() {
  return (
    <Card className="overflow-hidden border-foreground/[0.06] bg-card/95 shadow-[0_1px_2px_rgba(20,14,4,0.025),0_12px_32px_-16px_rgba(20,14,4,0.07)] dark:border-foreground/[0.08] dark:bg-card/80 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-16px_rgba(0,0,0,0.6)]">
      <div className="px-6 pt-5">
        <div className="flex items-center gap-2.5">
          <Newspaper className="h-4 w-4 text-foreground/45" />
          <h3 className="text-[15px] font-semibold tracking-[-0.005em]">
            What&apos;s new
          </h3>
        </div>
        <p className="mt-1 text-[12.5px] text-foreground/55">
          Recent releases and platform changes.
        </p>
      </div>

      <ol className="relative px-6 pb-5 pt-4">
        {/* timeline rail */}
        <span
          aria-hidden
          className="absolute left-[27px] top-5 bottom-7 w-px bg-gradient-to-b from-foreground/[0.1] via-foreground/[0.06] to-transparent"
        />
        {UPDATES.map((update, i) => (
          <li key={update.title} className="relative pb-5 last:pb-0">
            <span
              aria-hidden
              className={`absolute left-[21px] top-[7px] h-2.5 w-2.5 rounded-full ring-4 ring-[#FAFAF7] dark:ring-neutral-950 ${
                i === 0
                  ? "bg-gradient-to-br from-amber-400 to-orange-500 shadow-[0_0_0_2px_rgba(251,146,60,0.15)]"
                  : "bg-foreground/15"
              }`}
            />
            <div className="ml-9">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-foreground/55">
                  {update.date}
                </span>
                {update.tag ? (
                  <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 ring-1 ring-inset ring-amber-200/60 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-400/20">
                    {update.tag}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-[14px] font-semibold tracking-[-0.005em]">
                {update.title}
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/60">
                {update.body}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
