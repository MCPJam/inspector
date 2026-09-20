import { useRef, useState } from "react";
import {
  ArrowRight,
  Play,
  Sparkles,
  X,
  Network,
  Users,
  FlaskConical,
  GitBranch,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@mcpjam/design-system/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@mcpjam/design-system/tabs";
import { ProductUpdateVideoPlayer } from "../home/ProductUpdateVideoPlayer";
import { SwarmHeroCharacters } from "../swarms/swarm-hero-characters";
import {
  LaunchFeatureVisual,
  type LaunchFeatureId,
} from "./launch-feature-visual";
import type { ProductUpdateEntry } from "../home/productUpdateEntry";

const LAUNCH: ProductUpdateEntry = {
  _id: "platform-launch-2026-09",
  slug: "platform-launch-2026-09",
  publishAt: Date.UTC(2026, 8, 18),
  title: "Meet the new MCPJam",
  body: "From your first test to every release. Build confidence in your MCP server with one connected testing platform.",
  videoUrl: "https://www.youtube.com/watch?v=vD06SWzNx0Y",
  dismissed: false,
  isNew: true,
};

const FEATURES = [
  {
    id: "swarms" as const,
    path: "/swarms",
    icon: Network,
    name: "Swarm",
    title: "Find the edge cases before your users do.",
    body: "Simulate user scenarios in parallel across ChatGPT, Claude, and more. See where your server holds up and where it breaks.",
  },
  {
    id: "user-testing" as const,
    path: "/user-testing",
    icon: Users,
    name: "User Testing",
    title: "See your product through your users’ eyes.",
    body: "Invite real people to try your server. Bring their feedback and session insights together to uncover usability gaps.",
  },
  {
    id: "evals" as const,
    path: "/evaluate",
    icon: FlaskConical,
    name: "Evals",
    title: "Turn a good result into a repeatable test.",
    body: "Build durable test suites from user workflows, then run them across clients to measure quality as your server evolves.",
  },
  {
    id: "ci-cd" as const,
    path: "/evaluate",
    icon: GitBranch,
    name: "CI/CD",
    title: "Make confidence part of every release.",
    body: "Run cross-client evaluations in your release pipeline and catch regressions before they reach your users.",
  },
];

const STORAGE_KEY = `mcpjam:${LAUNCH.slug}:status`;
type LaunchStatus = "unseen" | "seen" | "dismissed";

/** Browser-scoped so guests keep their launch history when they sign in. */
export function PlatformLaunchAnnouncement({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate: (path: string) => void;
}) {
  const [status, setStatus] = useState<LaunchStatus>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved === "seen" || saved === "dismissed" ? saved : "unseen";
    } catch {
      return "unseen";
    }
  });
  // Keep the trigger stable for focus restoration; quiet the card on the next visit.
  const showCard = useRef(status === "unseen").current;
  const [open, setOpen] = useState(false);
  const [feature, setFeature] = useState<LaunchFeatureId>("swarms");
  const selected = FEATURES.find((item) => item.id === feature)!;
  const [playing, setPlaying] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  function remember(next: LaunchStatus) {
    setStatus(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Keep working when browser storage is unavailable.
    }
  }

  if (status === "dismissed") return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) remember("seen");
        if (!next) setPlaying(false);
      }}
    >
      {collapsed || !showCard ? (
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size={collapsed ? "icon" : "sm"}
            aria-label="Discover the new MCPJam"
            title="Discover the new MCPJam"
          >
            <Sparkles className="size-4" aria-hidden />
            {!collapsed && "What’s new"}
          </Button>
        </DialogTrigger>
      ) : (
        <section
          aria-label="Platform launch"
          className="relative overflow-hidden rounded-lg border border-border bg-background text-foreground"
        >
          <div className="h-0.5 bg-primary" />
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1 size-7"
            aria-label="Dismiss launch announcement"
            onClick={() => remember("dismissed")}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
          <DialogTrigger asChild>
            <button
              type="button"
              aria-label="See what’s new"
              className="group block w-full px-3 pb-3 pt-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
            >
              <p className="pr-6 text-[10px] font-semibold uppercase tracking-widest">
                Meet the new MCPJam
              </p>
              <SwarmHeroCharacters className="my-3" />
              <div className="grid grid-cols-2 gap-1.5">
                {FEATURES.map(({ name, icon: Icon }) => (
                  <span
                    key={name}
                    className="flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-2 text-[10px] whitespace-nowrap font-medium"
                  >
                    <Icon
                      className="size-3 shrink-0 text-primary"
                      aria-hidden
                    />
                    {name}
                  </span>
                ))}
              </div>
              <span className="mt-3 flex items-center justify-between text-xs font-semibold">
                See what’s new
                <ArrowRight
                  className="size-3.5 transition-transform motion-safe:group-hover:translate-x-0.5"
                  aria-hidden
                />
              </span>
            </button>
          </DialogTrigger>
        </section>
      )}
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 motion-reduce:animate-none sm:max-w-3xl sm:p-8"
      >
        <DialogHeader className="pr-6 text-left">
          <p className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-foreground">
            <Sparkles className="size-4 text-primary" aria-hidden />
            Platform launch · September 2026
          </p>
          <DialogTitle
            ref={titleRef}
            tabIndex={-1}
            className="text-2xl leading-tight sm:text-3xl"
          >
            {LAUNCH.title}
          </DialogTitle>
          <DialogDescription className="max-w-xl text-foreground">
            {LAUNCH.body}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={feature}
          onValueChange={(value) => {
            setFeature(value as LaunchFeatureId);
            setPlaying(false);
          }}
        >
          <TabsList
            aria-label="Explore platform features"
            className="grid h-auto w-full grid-cols-2 sm:grid-cols-4"
          >
            {FEATURES.map(({ id, name }) => (
              <TabsTrigger key={name} value={id}>
                {name}
              </TabsTrigger>
            ))}
          </TabsList>
          {FEATURES.map(({ id, name, title, body }) => (
            <TabsContent key={name} value={id} className="space-y-4 pt-3">
              {playing ? (
                <ProductUpdateVideoPlayer entry={LAUNCH} />
              ) : (
                <LaunchFeatureVisual feature={id} />
              )}
              <div className="flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-widest text-foreground">
                <span>{playing ? "Launch film" : "Feature preview"}</span>
                <span>
                  {String(
                    FEATURES.findIndex((item) => item.id === id) + 1,
                  ).padStart(2, "0")}{" "}
                  / 04
                </span>
              </div>
              <h3 className="text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-foreground">
                {body}
              </p>
            </TabsContent>
          ))}
        </Tabs>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
              setPlaying(false);
              onNavigate(selected.path);
            }}
          >
            {feature === "ci-cd"
              ? "Open Evaluate for CI/CD"
              : `Explore ${selected.name}`}
            <ArrowRight className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            onClick={() => setPlaying(!playing)}
            aria-label={playing ? "Show feature preview" : "Play launch video"}
          >
            <Play className="size-3.5" aria-hidden />
            {playing ? "Show feature preview" : "Watch launch film"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setOpen(false);
              setPlaying(false);
            }}
          >
            Back to work
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
