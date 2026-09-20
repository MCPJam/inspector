import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Play,
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
import { LaunchFeatureVisual } from "./launch-feature-visual";
import { LAUNCH_ID, type LaunchEngagement } from "@/shared/launch-engagement";
import { trackLaunchEngagement } from "@/lib/launch-analytics";
import type { ProductUpdateEntry } from "../home/productUpdateEntry";

const LAUNCH: ProductUpdateEntry = {
  _id: LAUNCH_ID,
  slug: LAUNCH_ID,
  publishAt: Date.UTC(2026, 8, 18),
  title: "Check out our new platform",
  body: "We've just launched a suite of new features to help you test the full lifecycle of your MCP servers!",
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
    title: "Swarms",
    body: "Simulate many user scenarios across ChatGPT, Claude, and more in parallel. Catch the edge cases your tests miss.",
  },
  {
    id: "user-testing" as const,
    path: "/user-testing",
    icon: Users,
    name: "User Testing",
    title: "User Testing",
    body: "See how real users interact with your product. Measure sentiment and uncover usability gaps.",
  },
  {
    id: "evals" as const,
    path: "/evaluate",
    icon: FlaskConical,
    name: "Evaluate",
    title: "Evaluate",
    body: "Turn user workflows into repeatable, durable test suites. Re-run them automatically across your preferred clients.",
  },
  {
    id: "ci-cd" as const,
    path: "/evaluate",
    icon: GitBranch,
    name: "CI/CD",
    title: "CI/CD",
    body: "Block failures before they ship. Make durable cross client evaluation part of every release.",
  },
];

const launchTabClassName =
  "h-11 flex-none gap-2 rounded-md border-border bg-background px-3 text-xs font-medium hover:bg-accent data-[state=active]:border-foreground/40 data-[state=active]:bg-accent data-[state=active]:font-semibold data-[state=active]:shadow-none dark:data-[state=active]:border-foreground/40 dark:data-[state=active]:bg-accent dark:data-[state=active]:text-foreground sm:flex-1";

const STORAGE_KEY = `mcpjam:${LAUNCH.slug}:status`;
type LaunchStatus = "unseen" | "seen" | "dismissed";

/** Browser-scoped so guests keep their launch history when they sign in. */
export function PlatformLaunchAnnouncement({
  onNavigate,
  audience = "guest",
  sandboxesEnabled = false,
}: {
  sandboxesEnabled?: boolean;
  audience?: "guest" | "signed_in";
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
  const [open, setOpen] = useState(false);
  const [feature, setFeature] =
    useState<LaunchEngagement["feature"]>("launch-video");
  const selected = FEATURES.find((item) => item.id === feature);
  const canNavigate =
    !["swarms", "user-testing"].includes(feature) || sandboxesEnabled;
  const [playing, setPlaying] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const shown = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openedAt = useRef(0);
  const presentation = "card" as const;

  function engagement(
    action: LaunchEngagement["action"],
    extra: Partial<
      Pick<LaunchEngagement, "feature" | "duration_ms" | "close_reason">
    > = {},
  ) {
    trackLaunchEngagement({
      launch_id: LAUNCH_ID,
      action,
      feature,
      presentation,
      prior_status: status,
      audience,
      ...extra,
    });
  }

  useEffect(() => {
    if (status === "dismissed" || shown.current || !triggerRef.current) return;
    const emit = () => {
      if (shown.current) return;
      shown.current = true;
      trackLaunchEngagement({
        launch_id: LAUNCH_ID,
        action: "shown",
        feature: "launch-video",
        presentation,
        prior_status: status,
        audience,
      });
    };
    if (typeof IntersectionObserver === "undefined") {
      emit();
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        emit();
        observer.disconnect();
      }
    });
    observer.observe(triggerRef.current);
    return () => observer.disconnect();
  }, [status, presentation, audience]);

  function changeOpen(
    next: boolean,
    reason: LaunchEngagement["close_reason"] = "dismiss",
  ) {
    if (next) {
      setFeature("launch-video");
      engagement("opened", { feature: "launch-video" });
      openedAt.current = Date.now();
      remember("seen");
    } else if (open) {
      engagement("closed", {
        close_reason: reason,
        duration_ms: Math.min(
          86_400_000,
          Math.max(0, Date.now() - openedAt.current),
        ),
      });
    }
    setOpen(next);
    if (!next) setPlaying(false);
  }

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
    <Dialog open={open} onOpenChange={changeOpen}>
      <section
        aria-label="Platform launch"
        className="fixed bottom-4 left-4 z-40 w-[calc(var(--sidebar-width,16rem)-2rem)] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-background text-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200"
      >
        <div className="h-0.5 bg-primary" />
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-1 top-1 size-7"
          aria-label="Dismiss launch announcement"
          onClick={() => {
            engagement("dismissed");
            remember("dismissed");
          }}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
        <DialogTrigger asChild>
          <button
            type="button"
            ref={triggerRef}
            aria-label="Learn more about the new MCPJam"
            className="group block w-full px-3 pb-3 pt-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
          >
            <SwarmHeroCharacters className="my-5" />
            <h2 className="mb-2 text-center text-xl font-semibold tracking-tight">
              Check out our new platform
            </h2>
            <div className="grid grid-cols-2 gap-1.5">
              {FEATURES.map(({ name, icon: Icon }) => (
                <span
                  key={name}
                  className="flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-2 text-[10px] whitespace-nowrap font-medium"
                >
                  <Icon className="size-3 shrink-0 text-primary" aria-hidden />
                  {name}
                </span>
              ))}
            </div>
            <span className="mt-4 flex justify-center">
              <Button asChild>
                <span>
                  Learn more
                  <ArrowRight
                    className="size-3.5 transition-transform motion-safe:group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </span>
              </Button>
            </span>
          </button>
        </DialogTrigger>
      </section>
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 shadow-[0_0_40px_4px_color-mix(in_oklab,var(--primary)_20%,transparent)] motion-reduce:animate-none sm:max-w-4xl sm:p-8"
      >
        <DialogHeader className="pr-6 text-left">
          <div className="mb-2">
            <img
              src="/mcp_jam_light.png"
              alt="MCPJam"
              className="h-5 w-auto dark:hidden"
            />
            <img
              src="/mcp_jam_dark.png"
              alt="MCPJam"
              className="hidden h-5 w-auto dark:block"
            />
          </div>
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
          className="min-w-0"
          value={feature}
          onValueChange={(value) => {
            if (value !== feature)
              engagement("feature_selected", {
                feature: value as LaunchEngagement["feature"],
              });
            setFeature(value as LaunchEngagement["feature"]);
            setPlaying(false);
          }}
        >
          <TabsList
            aria-label="Explore platform features"
            className="h-auto w-full max-w-full justify-start gap-2 overflow-x-auto rounded-none bg-transparent p-1 text-foreground"
          >
            <TabsTrigger value="launch-video" className={launchTabClassName}>
              <Play className="size-3.5" aria-hidden />
              Launch video
            </TabsTrigger>
            {FEATURES.map(({ id, name, icon: Icon }) => (
              <TabsTrigger key={name} value={id} className={launchTabClassName}>
                <Icon className="size-3.5" aria-hidden />
                {name}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="launch-video" className="space-y-4 pt-3">
            {playing ? (
              <ProductUpdateVideoPlayer entry={LAUNCH} />
            ) : (
              <button
                type="button"
                aria-label="Play launch video"
                onClick={() => {
                  engagement("video_requested");
                  setPlaying(true);
                }}
                className="group relative block aspect-video w-full overflow-hidden rounded-lg border border-border bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <img
                  src="https://i.ytimg.com/vi/vD06SWzNx0Y/hqdefault.jpg"
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="flex size-16 items-center justify-center rounded-full border border-border bg-background text-foreground transition-transform motion-safe:group-hover:scale-105">
                    <Play className="ml-1 size-7 fill-current" aria-hidden />
                  </span>
                </span>
              </button>
            )}
          </TabsContent>
          {FEATURES.map(({ id, name, title, body }) => (
            <TabsContent key={name} value={id} className="space-y-4 pt-3">
              <LaunchFeatureVisual feature={id} />
              <h3 className="text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-foreground">
                {body}
              </p>
            </TabsContent>
          ))}
        </Tabs>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          {selected ? (
            <Button
              variant="default"
              disabled={!canNavigate}
              onClick={() => {
                engagement("feature_navigated");
                changeOpen(false, "navigate");
                onNavigate(selected.path);
              }}
            >
              {!canNavigate
                ? "Not available in this workspace"
                : feature === "ci-cd"
                ? "Open Evaluate for CI/CD"
                : `Explore ${selected.name}`}
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                engagement("feature_selected", { feature: "swarms" });
                setFeature("swarms");
                setPlaying(false);
              }}
            >
              Explore the features
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              changeOpen(false, "back_to_work");
            }}
          >
            Back to work
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
