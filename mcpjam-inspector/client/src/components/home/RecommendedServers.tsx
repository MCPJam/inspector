import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import {
  Loader2,
  Plus,
  Box,
  Wrench,
  Database,
  MessageSquareText,
  Server,
} from "lucide-react";
import { useAppNavigate, routePaths } from "@/lib/app-navigation";

const VISIBLE_COUNT = 3;

interface RecommendedServer {
  name: string;
  url: string;
  description: string;
  category: string;
}

interface RecommendedServersProps {
  servers: readonly RecommendedServer[] | undefined;
  projectId: string | null;
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getCategoryIcon(category: string) {
  switch (category) {
    case "MCP Apps":
      return Box;
    case "App Tools":
      return Wrench;
    case "Resources":
      return Database;
    case "Prompts":
      return MessageSquareText;
    default:
      return Server;
  }
}

export function RecommendedServers({
  servers,
  projectId,
}: RecommendedServersProps) {
  // create-if-missing makes a repeat click on an already-connected server
  // idempotent (returns the existing server) instead of throwing
  // "already exists", which was being logged server-side.
  const createServer = useMutation("servers:createServerIfMissing" as any);
  const navigate = useAppNavigate();
  const [connectingUrl, setConnectingUrl] = useState<string | null>(null);

  async function handleConnect(server: RecommendedServer) {
    if (!projectId) {
      toast.error("Select a project before connecting a server.");
      return;
    }
    setConnectingUrl(server.url);
    try {
      await createServer({
        projectId,
        name: slugifyName(server.name),
        enabled: true,
        transportType: "http",
        url: server.url,
      } as any);
      toast.success(`Connected ${server.name} to your workspace.`);
      navigate(routePaths.servers);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to connect ${server.name}: ${message}`);
    } finally {
      setConnectingUrl(null);
    }
  }

  const visible = servers?.slice(0, VISIBLE_COUNT);

  return (
    <section className="rounded-xl border border-border/60">
      <div className="border-b border-border/60 px-4 py-2">
        <h2 className="text-[13px] font-medium text-foreground">Recommended servers</h2>
      </div>

      {servers === undefined ? (
        <ul aria-busy="true" aria-label="Loading recommended servers">
          {Array.from({ length: VISIBLE_COUNT }).map((_, i) => (
            <li
              key={i}
              className={`flex items-center gap-2.5 px-4 py-2 ${
                i === VISIBLE_COUNT - 1 ? "" : "border-b border-border/40"
              }`}
            >
              <div className="size-6 shrink-0 animate-pulse rounded bg-muted" />
              <div className="h-3.5 w-24 animate-pulse rounded-sm bg-muted" />
            </li>
          ))}
        </ul>
      ) : visible && visible.length > 0 ? (
        <ul>
          {visible.map((server, i) => {
            const isConnecting = connectingUrl === server.url;
            const CategoryIcon = getCategoryIcon(server.category);
            const isLast = i === visible.length - 1;
            return (
              <li key={server.url} className={isLast ? "" : "border-b border-border/40"}>
                <button
                  type="button"
                  disabled={isConnecting || !projectId}
                  onClick={() => handleConnect(server)}
                  className="group flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="grid size-6 shrink-0 place-items-center rounded bg-muted/60 text-muted-foreground">
                    <CategoryIcon className="size-3.5" strokeWidth={1.75} />
                  </div>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {server.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-muted-foreground transition group-hover:text-foreground group-disabled:opacity-50">
                    {isConnecting ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <>
                        <Plus className="size-3" />
                        Connect
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-4 py-3 text-[11px] text-muted-foreground">
          No recommendations right now.
        </p>
      )}
    </section>
  );
}
