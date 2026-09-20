import { useRef, useState } from "react";
import { ArrowUpRight, Play, Sparkles, X } from "lucide-react";
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
import type { ProductUpdateEntry } from "../home/productUpdateEntry";

const LAUNCH: ProductUpdateEntry = {
  _id: "platform-launch-2026-09",
  slug: "platform-launch-2026-09",
  publishAt: Date.UTC(2026, 8, 18),
  title: "Meet the new MCPJam",
  body: "From your first test to every release. Build confidence in your MCP server with one connected testing platform.",
  href: "https://www.mcpjam.com/blog/our-new-platform",
  videoUrl: "https://www.youtube.com/watch?v=vD06SWzNx0Y",
  dismissed: false,
  isNew: true,
};

const FEATURES = [
  {
    name: "Swarms",
    title: "Find the edge cases before your users do.",
    body: "Simulate user scenarios in parallel across ChatGPT, Claude, and more. See where your server holds up and where it breaks.",
  },
  {
    name: "User Testing",
    title: "See your product through your users’ eyes.",
    body: "Invite real people to try your server. Bring their feedback and session insights together to uncover usability gaps.",
  },
  {
    name: "Evals",
    title: "Turn a good result into a repeatable test.",
    body: "Build durable test suites from user workflows, then run them across clients to measure quality as your server evolves.",
  },
  {
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
}: {
  collapsed?: boolean;
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
          <div className="px-3 pb-3 pt-3">
            <div className="mb-2 flex items-center gap-1.5 pr-5 text-[10px] font-semibold uppercase tracking-widest">
              <Sparkles className="size-3 text-primary" aria-hidden />A new
              chapter
            </div>
            <p className="text-sm font-semibold leading-snug">{LAUNCH.title}</p>
            <p className="mt-1 text-xs leading-relaxed">
              More ways to test. More confidence to ship.
            </p>
            <DialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="mt-3 w-full justify-between"
              >
                <span className="flex items-center gap-1.5">
                  <Play className="size-3.5" aria-hidden />
                  See what’s new
                </span>
                <ArrowUpRight className="size-3.5" aria-hidden />
              </Button>
            </DialogTrigger>
          </div>
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
        {playing ? (
          <ProductUpdateVideoPlayer entry={LAUNCH} />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            aria-label="Play launch video"
            className="group flex aspect-video w-full flex-col items-center justify-center gap-4 rounded-lg border border-border bg-muted px-6 text-center text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="flex size-12 items-center justify-center rounded-full border border-border bg-background transition-transform motion-safe:group-hover:scale-105">
              <Play className="size-5 text-primary" aria-hidden />
            </span>
            <span className="max-w-sm text-xl font-semibold leading-tight sm:text-3xl">
              Don’t ship MCP servers
              <br />
              that fail.
            </span>
            <span className="text-xs font-medium">
              Watch the launch film <span aria-hidden>↗</span>
            </span>
          </button>
        )}
        <Tabs defaultValue="swarms">
          <TabsList
            aria-label="Explore platform features"
            className="grid h-auto w-full grid-cols-2 sm:grid-cols-4"
          >
            {FEATURES.map(({ name }) => (
              <TabsTrigger
                key={name}
                value={name.toLowerCase().replace(/[^a-z]+/g, "-")}
              >
                {name}
              </TabsTrigger>
            ))}
          </TabsList>
          {FEATURES.map(({ name, title, body }) => (
            <TabsContent
              key={name}
              value={name.toLowerCase().replace(/[^a-z]+/g, "-")}
              className="min-h-28 px-1 pt-3"
            >
              <h3 className="text-base font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-foreground">
                {body}
              </p>
            </TabsContent>
          ))}
        </Tabs>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <Button variant="outline" asChild>
            <a href={LAUNCH.href} target="_blank" rel="noopener noreferrer">
              Explore the launch
              <ArrowUpRight className="size-4" aria-hidden />
            </a>
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
