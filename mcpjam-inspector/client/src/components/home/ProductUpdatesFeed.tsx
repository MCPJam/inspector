import { Card, CardContent, CardHeader, CardTitle } from "@mcpjam/design-system/card";
import { Newspaper } from "lucide-react";

interface ProductUpdate {
  date: string;
  title: string;
  body: string;
}

const UPDATES: ProductUpdate[] = [
  {
    date: "May 2026",
    title: "Stateless MCP (DRAFT-2026-v1)",
    body: "Configure per-server protocol mode for stateless HTTP MCP — three layers of control from org default to per-server override.",
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
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Newspaper className="h-4 w-4 text-muted-foreground" />
          What&apos;s new
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {UPDATES.map((update) => (
            <li key={update.title} className="px-5 py-4">
              <span className="text-xs font-medium text-muted-foreground">
                {update.date}
              </span>
              <p className="mt-0.5 text-sm font-medium">{update.title}</p>
              <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                {update.body}
              </p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
