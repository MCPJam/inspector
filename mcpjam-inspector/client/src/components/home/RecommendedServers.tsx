import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Sparkles, Loader2, Plus, ArrowUpRight } from "lucide-react";
import { Card } from "@mcpjam/design-system/card";
import { Button } from "@mcpjam/design-system/button";
import { useAppNavigate, routePaths } from "@/lib/app-navigation";

interface RecommendedServer {
  name: string;
  url: string;
  description: string;
  category: string;
}

interface RecommendedServersProps {
  servers: readonly RecommendedServer[];
  projectId: string | null;
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface CategoryStyle {
  tile: string;
  chip: string;
}

const CATEGORY_STYLES: Record<string, CategoryStyle> = {
  "MCP Apps": {
    tile: "bg-gradient-to-br from-orange-100 to-amber-200/80 text-orange-700 ring-orange-200/50 dark:from-orange-500/20 dark:to-amber-500/20 dark:text-orange-200 dark:ring-orange-400/20",
    chip: "bg-orange-50 text-orange-700 ring-orange-200/60 dark:bg-orange-500/10 dark:text-orange-200 dark:ring-orange-400/20",
  },
  "App Tools": {
    tile: "bg-gradient-to-br from-emerald-100 to-teal-200/80 text-emerald-700 ring-emerald-200/50 dark:from-emerald-500/20 dark:to-teal-500/20 dark:text-emerald-200 dark:ring-emerald-400/20",
    chip: "bg-emerald-50 text-emerald-700 ring-emerald-200/60 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-400/20",
  },
  Resources: {
    tile: "bg-gradient-to-br from-sky-100 to-indigo-200/80 text-sky-700 ring-sky-200/50 dark:from-sky-500/20 dark:to-indigo-500/20 dark:text-sky-200 dark:ring-sky-400/20",
    chip: "bg-sky-50 text-sky-700 ring-sky-200/60 dark:bg-sky-500/10 dark:text-sky-200 dark:ring-sky-400/20",
  },
  Prompts: {
    tile: "bg-gradient-to-br from-violet-100 to-fuchsia-200/80 text-violet-700 ring-violet-200/50 dark:from-violet-500/20 dark:to-fuchsia-500/20 dark:text-violet-200 dark:ring-violet-400/20",
    chip: "bg-violet-50 text-violet-700 ring-violet-200/60 dark:bg-violet-500/10 dark:text-violet-200 dark:ring-violet-400/20",
  },
  default: {
    tile: "bg-gradient-to-br from-stone-100 to-zinc-200/70 text-stone-700 ring-stone-200/50 dark:from-stone-500/20 dark:to-zinc-500/20 dark:text-stone-200 dark:ring-stone-400/20",
    chip: "bg-stone-50 text-stone-700 ring-stone-200/60 dark:bg-stone-500/10 dark:text-stone-200 dark:ring-stone-400/20",
  },
};

function getCategoryStyle(cat: string): CategoryStyle {
  return CATEGORY_STYLES[cat] ?? CATEGORY_STYLES.default;
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
    <Card className="overflow-hidden border-foreground/[0.06] bg-card/95 shadow-[0_1px_2px_rgba(20,14,4,0.025),0_12px_32px_-16px_rgba(20,14,4,0.08)] backdrop-blur-[2px] dark:border-foreground/[0.08] dark:bg-card/80 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-16px_rgba(0,0,0,0.6)]">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-6 pt-6">
        <div className="flex items-center gap-3.5">
          <div className="relative grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 via-indigo-500 to-blue-500 text-white shadow-[0_4px_12px_-2px_rgba(99,102,241,0.45),inset_0_1px_0_rgba(255,255,255,0.25)] ring-1 ring-white/10">
            <Sparkles className="h-[18px] w-[18px]" />
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-300 ring-2 ring-[#FAFAF7] dark:ring-neutral-950" />
          </div>
          <div>
            <h2 className="text-[16px] font-semibold tracking-[-0.01em]">
              Recommended servers
            </h2>
            <p className="mt-0.5 text-[12.5px] text-foreground/55">
              Hand-picked MCP servers to test with your clients
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-[12.5px] text-foreground/65 hover:text-foreground"
          onClick={() => navigate(routePaths.servers)}
        >
          Browse all
          <ArrowUpRight className="ml-0.5 h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="mx-6 mt-5 border-t border-foreground/[0.06]" />

      {/* Body */}
      {servers.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <p className="text-sm text-foreground/55">
            No recommendations available right now.
          </p>
        </div>
      ) : (
        <ul className="px-3 py-2">
          {servers.map((server) => {
            const isConnecting = connectingUrl === server.url;
            const style = getCategoryStyle(server.category);
            return (
              <li
                key={server.url}
                className="group flex items-center gap-3.5 rounded-xl px-3 py-3 transition-colors hover:bg-foreground/[0.025] dark:hover:bg-foreground/[0.04]"
              >
                <div
                  className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[15px] font-semibold ring-1 ring-inset ${style.tile}`}
                >
                  {server.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[14px] font-medium tracking-[-0.005em]">
                      {server.name}
                    </p>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium tracking-wide ring-1 ring-inset ${style.chip}`}
                    >
                      {server.category}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[13px] text-foreground/55">
                    {server.description}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 border-foreground/10 bg-card/60 text-[12.5px] font-medium text-foreground/75 hover:border-foreground/20 hover:text-foreground"
                  disabled={isConnecting || !projectId}
                  onClick={() => handleConnect(server)}
                >
                  {isConnecting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Connecting
                    </>
                  ) : (
                    <>
                      <Plus className="h-3.5 w-3.5" />
                      Connect
                    </>
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
