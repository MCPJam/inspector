import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@mcpjam/design-system/card";
import { Badge } from "@mcpjam/design-system/badge";
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
    title: "Stateless MCP (2026 RC, 2026-07-28)",
    body: "Try the MCP 2026-07-28 stateless RC against your own servers — per-server protocol mode with three layers of control from org default to per-server override.",
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
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="px-6 pb-3 pt-5">
        <CardTitle className="flex items-center gap-2 text-[15px] tracking-[-0.005em]">
          <Newspaper className="size-4 text-muted-foreground" strokeWidth={1.75} />
          What&apos;s new
        </CardTitle>
        <CardDescription className="text-[12.5px]">
          Recent releases and platform changes.
        </CardDescription>
      </CardHeader>

      <CardContent className="px-6 pb-6 pt-3">
        <ol className="relative">
          {/* timeline rail */}
          <span
            aria-hidden
            className="absolute left-[5px] top-1.5 bottom-2 w-px bg-border"
          />
          {UPDATES.map((update, i) => (
            <li key={update.title} className="relative pb-5 pl-7 last:pb-0">
              <span
                aria-hidden
                className={`absolute left-0 top-[5px] size-[11px] rounded-full ring-4 ring-card ${
                  i === 0 ? "bg-primary" : "bg-border"
                }`}
              />
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  {update.date}
                </span>
                {update.tag ? (
                  <Badge className="h-4 px-1.5 text-[9.5px] tracking-wider">
                    {update.tag}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 text-[14px] font-semibold tracking-[-0.005em] text-foreground">
                {update.title}
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                {update.body}
              </p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
