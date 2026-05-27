import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import {
  Sparkles,
  Loader2,
  Plus,
  ArrowUpRight,
  Box,
  Wrench,
  Database,
  MessageSquareText,
  Server,
} from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
} from "@mcpjam/design-system/card";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { useAppNavigate, routePaths } from "@/lib/app-navigation";

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
  const createServer = useMutation("servers:createServer" as any);
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
      if (message.includes("already exists")) {
        toast.info(`${server.name} is already connected.`);
        navigate(routePaths.servers);
      } else {
        toast.error(`Failed to connect ${server.name}: ${message}`);
      }
    } finally {
      setConnectingUrl(null);
    }
  }

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="px-6 pb-5 pt-6">
        <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/15">
          <Sparkles className="size-[18px]" strokeWidth={1.75} />
        </div>
        <CardTitle className="mt-3 text-[15px] tracking-[-0.005em]">
          Recommended servers
        </CardTitle>
        <CardDescription className="text-[12.5px]">
          Hand-picked MCP servers to test with your clients.
        </CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => navigate(routePaths.servers)}
          >
            Browse all
            <ArrowUpRight />
          </Button>
        </CardAction>
      </CardHeader>

      <div className="border-t border-border/60" />

      <CardContent className="px-3 py-2">
        {servers === undefined ? (
          <ul aria-busy="true" aria-label="Loading recommended servers">
            {Array.from({ length: 3 }).map((_, i) => (
              <li
                key={i}
                className={`flex items-center gap-4 rounded-lg px-3 py-3.5 ${
                  i === 2 ? "" : "border-b border-border/40"
                }`}
              >
                <div className="size-10 shrink-0 animate-pulse rounded-lg bg-muted" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-3.5 w-32 animate-pulse rounded-sm bg-muted" />
                  <div className="h-3 w-48 animate-pulse rounded-sm bg-muted" />
                </div>
                <div className="h-8 w-[88px] shrink-0 animate-pulse rounded-md bg-muted" />
              </li>
            ))}
          </ul>
        ) : servers.length === 0 ? (
          <div className="px-3 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              No recommendations available right now.
            </p>
          </div>
        ) : (
          <ul>
            {servers.map((server, i) => {
              const isConnecting = connectingUrl === server.url;
              const CategoryIcon = getCategoryIcon(server.category);
              const isLast = i === servers.length - 1;
              return (
                <li
                  key={server.url}
                  className={`group flex items-center gap-4 rounded-lg px-3 py-3.5 transition-colors hover:bg-accent/60 ${
                    isLast ? "" : "border-b border-border/40"
                  }`}
                >
                  <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground ring-1 ring-inset ring-border/40">
                    <CategoryIcon className="size-[18px]" strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-[14px] font-medium tracking-[-0.005em] text-foreground">
                        {server.name}
                      </p>
                      <Badge
                        variant="secondary"
                        className="h-5 px-1.5 text-[10.5px] font-medium tracking-wide text-muted-foreground"
                      >
                        {server.category}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
                      {server.description}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isConnecting || !projectId}
                    onClick={() => handleConnect(server)}
                  >
                    {isConnecting ? (
                      <>
                        <Loader2 className="animate-spin" />
                        Connecting
                      </>
                    ) : (
                      <>
                        <Plus />
                        Connect
                      </>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
