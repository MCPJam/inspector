import { useEffect, useRef, useState, type ReactNode } from "react";
import { Star } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  FeatureSpotlightActions,
  FeatureSpotlightDescription,
  FeatureSpotlightTitle,
} from "@mcpjam/design-system/feature-spotlight";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { GitHubIcon } from "@/components/ui/github-icon";
import { AnnouncementSpotlight } from "@/components/announcement-popups";
import { track } from "@/lib/analytics";
import {
  closeGitHubStarPrompt,
  rememberGitHubStarPrompt,
  useGitHubStarPrompt,
  type GitHubStarPromptRequest,
} from "@/lib/github-star-prompt";

const REPO = "MCPJam/inspector";
const REPO_URL = `https://github.com/${REPO}`;
const CACHE_KEY = `gh-stars:${REPO}`;
const CACHE_TTL_MS = 60 * 60 * 1000;

function formatCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `${k.toFixed(k >= 10 ? 0 : 1)}k`;
  }
  return n.toLocaleString();
}

function readCache(): number | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { count, ts } = JSON.parse(raw) as { count: number; ts: number };
    if (Date.now() - ts > CACHE_TTL_MS) return null;
    return count;
  } catch {
    return null;
  }
}

function writeCache(count: number) {
  try {
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ count, ts: Date.now() }),
    );
  } catch {
    // ignore
  }
}

export function GitHubStarButton({
  location,
  prompt = false,
}: {
  location: "header" | "settings";
  /** Shows the star ask here when a flow requests it. One placement only. */
  prompt?: boolean;
}) {
  const [count, setCount] = useState<number | null>(() => readCache());
  const request = useGitHubStarPrompt();
  const promptRequest = prompt ? request : null;
  const linkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (count !== null) return;
    let cancelled = false;
    fetch(`https://api.github.com/repos/${REPO}`, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const stars = data.stargazers_count;
        if (typeof stars === "number") {
          setCount(stars);
          writeCache(stars);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [count]);

  const button = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          variant="chrome"
          size="sm"
          className="gap-1.5 px-2 sm:px-2.5"
        >
          <a
            ref={linkRef}
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label={`Star ${REPO} on GitHub`}
            onClick={() => {
              track("github_star_button_clicked", { location });
              if (promptRequest) {
                trackPrompt("github_star_prompt_clicked", promptRequest, {
                  cta: "star_button",
                });
              }
              // Starred, most likely: never ask this browser afterwards.
              closeGitHubStarPrompt();
            }}
          >
            <GitHubIcon className="h-4 w-4" data-chrome-icon />
            <Star className="h-3.5 w-3.5" data-chrome-icon />
            <span className="hidden text-xs font-medium sm:inline">Star</span>
            {count !== null && (
              <span className="hidden text-xs font-medium border-l border-border/60 pl-1.5 ml-0.5 text-muted-foreground sm:inline">
                {formatCount(count)}
              </span>
            )}
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Star us on GitHub</TooltipContent>
    </Tooltip>
  );

  if (!promptRequest) return button;
  return (
    <GitHubStarPrompt
      request={promptRequest}
      anchor={button}
      isAnchor={(target) =>
        target instanceof Node && Boolean(linkRef.current?.contains(target))
      }
    />
  );
}

function trackPrompt(
  event:
    | "github_star_prompt_shown"
    | "github_star_prompt_clicked"
    | "github_star_prompt_dismissed",
  request: GitHubStarPromptRequest,
  extra: Record<string, string> = {},
): void {
  track(event, {
    location: "header",
    trigger: request.trigger,
    reason: request.reason,
    ...("hasAdvice" in request ? { has_advice: request.hasAdvice } : {}),
    ...extra,
  });
}

const FEATURE_NAMES = {
  conformance: "conformance run",
  oauth: "OAuth flow",
  xaa: "XAA flow",
} as const;

function promptTitle(request: GitHubStarPromptRequest): string {
  if (request.reason === "return_visit")
    return request.trigger === "oauth"
      ? "Enjoying the OAuth debugger?"
      : "Enjoying the XAA debugger?";
  return `Your ${FEATURE_NAMES[request.trigger]} is complete`;
}

const OPEN_DIALOG =
  '[data-slot="dialog-content"][data-state="open"], [data-slot="alert-dialog-content"][data-state="open"]';

const DIALOG_SETTLE_MS = 500;

/**
 * Dialogs outside the announcement queue, such as the OAuth target setup.
 * Starts blocked, because a dialog opened by the same navigation can mount
 * just after the prompt is requested.
 */
function useDialogOpen(): boolean {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (document.querySelector(OPEN_DIALOG) !== null) {
        clearTimeout(settle);
        settle = undefined;
        setOpen(true);
      } else if (settle === undefined) {
        settle = setTimeout(() => setOpen(false), DIALOG_SETTLE_MS);
      }
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributeFilter: ["data-state"],
    });
    return () => {
      clearTimeout(settle);
      observer.disconnect();
    };
  }, []);
  return open;
}

function GitHubStarPrompt({
  request,
  anchor,
  isAnchor,
}: {
  request: GitHubStarPromptRequest;
  anchor: ReactNode;
  /** A click on the Star button itself is handled by the button. */
  isAnchor: (target: EventTarget | null) => boolean;
}) {
  const shown = useRef(false);
  const dialogOpen = useDialogOpen();
  // Leaving the page (e.g. browser Back) must not bring the ask back later.
  useEffect(
    () => () => {
      if (shown.current) closeGitHubStarPrompt();
    },
    [],
  );
  const dismiss = (closeReason: "not_now" | "dismiss") => {
    trackPrompt("github_star_prompt_dismissed", request, {
      close_reason: closeReason,
    });
    closeGitHubStarPrompt();
  };

  return (
    <AnnouncementSpotlight
      eligible={!dialogOpen}
      anchor={anchor}
      side="bottom"
      align="end"
      alignOffset={0}
      onShown={() => {
        if (shown.current) return;
        shown.current = true;
        // Seen once it gets its turn, not when it was requested.
        rememberGitHubStarPrompt();
        trackPrompt("github_star_prompt_shown", request);
      }}
      onDismiss={() => dismiss("dismiss")}
      onInteractOutside={(event) => {
        if (isAnchor(event.target)) event.preventDefault();
      }}
      // Focus stays on the page when this opens, so tabbing must not close it.
      onFocusOutside={(event) => event.preventDefault()}
    >
      <FeatureSpotlightTitle>{promptTitle(request)}</FeatureSpotlightTitle>
      <FeatureSpotlightDescription>
        MCPJam is open source. If this helped, a star on GitHub helps other MCP
        developers find us.
      </FeatureSpotlightDescription>
      <FeatureSpotlightActions>
        <Button size="sm" asChild>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            onClick={() => {
              trackPrompt("github_star_prompt_clicked", request, {
                cta: "primary",
              });
              closeGitHubStarPrompt();
            }}
          >
            <Star aria-hidden />
            Star on GitHub
          </a>
        </Button>
        <Button size="sm" variant="ghost" onClick={() => dismiss("not_now")}>
          Not now
        </Button>
      </FeatureSpotlightActions>
    </AnnouncementSpotlight>
  );
}
