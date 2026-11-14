import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
} from "react";
import { Maximize2 } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import {
  HoverCard,
  HoverCardBody,
  HoverCardContent,
  HoverCardHeader,
  HoverCardTrigger,
} from "@mcpjam/design-system/hover-card";
import { learnMoreContent } from "@/lib/learn-more-content";
import { cn } from "@/lib/utils";

export const SIDEBAR_HOVER_OPEN_DELAY_MS = 300;
export const SIDEBAR_HOVER_CLOSE_DELAY_MS = 200;

// At most one sidebar card is open. Only Radix's onOpenChange(true) writes
// the owner, so every open card is one Radix opened and will also close, and
// a new owner closes the previous card at once rather than after its grace.
let openOwner: string | null = null;
const ownerListeners = new Set<() => void>();

function setOpenOwner(next: string | null) {
  if (openOwner === next) return;
  openOwner = next;
  ownerListeners.forEach((listener) => listener());
}

function subscribeToOwner(listener: () => void) {
  ownerListeners.add(listener);
  return () => {
    ownerListeners.delete(listener);
  };
}

function getOpenOwner() {
  return openOwner;
}

// Whether the last input was a key press rather than a pointer press. The
// browser's own :focus-visible counts focus a closing menu hands back as
// keyboard focus, even when the menu was used with the mouse.
let lastInputWasKey = false;
let inputTracked = false;
const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

function trackInputModality() {
  if (inputTracked) return;
  inputTracked = true;
  document.addEventListener(
    "keydown",
    (event) => {
      // A shortcut such as switching windows says nothing about focus here.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (MODIFIER_KEYS.has(event.key)) return;
      lastInputWasKey = true;
    },
    true
  );
  document.addEventListener(
    "pointerdown",
    () => {
      lastInputWasKey = false;
    },
    true
  );
}

const blobCache: Record<string, string> = {};
let previewsPreloaded = false;

async function preloadClip(url: string) {
  try {
    const res = await fetch(url);
    blobCache[url] = URL.createObjectURL(await res.blob());
  } catch {
    // The cache already holds the URL itself, so the card streams it; a
    // failed preload only costs the first hover a short load.
  }
}

// Fetch every preview clip once, so the first hover plays without a network
// wait. Until a fetch lands, and if it fails, the card streams the URL.
function preloadPreviewVideos() {
  if (
    previewsPreloaded ||
    typeof fetch !== "function" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return;
  }
  previewsPreloaded = true;

  for (const entry of Object.values(learnMoreContent)) {
    const url = entry.previewVideoUrl;
    if (!url || url in blobCache) continue;
    blobCache[url] = url;
    void preloadClip(url);
  }
}

async function playFromStart(video: HTMLVideoElement) {
  video.currentTime = 0;
  try {
    await video.play();
  } catch {
    // Autoplay can be refused (power saving, no user gesture); the first
    // frame still shows, so there is nothing to recover.
  }
}

interface SidebarItemHoverCardProps {
  title: string;
  /** Shown in the pill; the collapsed rail clips the row's own badge. */
  badge?: string;
  /**
   * Learn-more entry key. Its clip and description show only when `onExpand`
   * is set; an entry without a clip shows its description alone.
   */
  tabId?: string;
  /** Opens the learn-more panel. Absent when the learn-more flag is off. */
  onExpand?: (tabId: string, sourceRect: DOMRect | null) => void;
  disabledMessage?: string;
  /**
   * The trigger already shows the title in full, so a card with nothing
   * else to say stays shut.
   */
  labelVisible?: boolean;
  /**
   * Holds the card shut while the trigger owns another popover (a menu), so
   * the two don't open over the same spot.
   */
  suppressed?: boolean;
  children: React.ReactNode;
}

export function SidebarItemHoverCard({
  title,
  badge,
  tabId,
  onExpand,
  disabledMessage,
  labelVisible = false,
  suppressed = false,
  children,
}: SidebarItemHoverCardProps) {
  const id = useId();
  const owner = useSyncExternalStore(
    subscribeToOwner,
    getOpenOwner,
    getOpenOwner
  );
  const pointerOnTriggerRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Set while suppressed: an open Radix scheduled before the menu took the
  // trigger is stale and must not land after the menu closes.
  const staleIntentRef = useRef(false);

  const entry = tabId ? learnMoreContent[tabId] : undefined;
  const preview =
    onExpand && (entry?.previewVideoUrl || entry?.description)
      ? entry
      : undefined;
  const clipUrl = preview?.previewVideoUrl;
  const hasBody = !!preview || !!disabledMessage;
  const enabled = (!labelVisible || hasBody) && !suppressed;
  const open = enabled && owner === id;
  // Another card took over: drop this one now instead of fading it out, so
  // two never show together.
  const handedOff = owner !== null && owner !== id;

  const release = useCallback(() => {
    if (getOpenOwner() === id) setOpenOwner(null);
  }, [id]);

  useEffect(() => {
    trackInputModality();
  }, []);

  useEffect(() => {
    if (clipUrl) preloadPreviewVideos();
  }, [clipUrl]);

  useEffect(() => {
    if (suppressed) staleIntentRef.current = true;
  }, [suppressed]);

  // Let go when a menu takes the trigger or the card has nothing to show,
  // so releasing suppression with the pointer still there doesn't flash the
  // card back.
  useEffect(() => {
    if (!enabled) release();
  }, [enabled, release]);

  useEffect(() => release, [release]);

  // A fresh open mounts a new clip, which autoplays from the start. The
  // content stays mounted through its fade-out, though: pause on close or
  // the old clip keeps playing beside the next card's, and rewind if the
  // card reopens before it unmounts.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (open) {
      void playFromStart(video);
    } else {
      video.pause();
    }
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      // Only the owner may clear: a card that already lost ownership can
      // still have a close timer running from when it was open.
      release();
    } else if (enabled && !staleIntentRef.current) {
      setOpenOwner(id);
    }
  };

  const handleTriggerPointerEnter = () => {
    pointerOnTriggerRef.current = true;
    staleIntentRef.current = false;
  };

  const handleTriggerPointerLeave = () => {
    pointerOnTriggerRef.current = false;
  };

  // Radix opens on any focus. Only keyboard focus means someone is looking
  // for this item; focus from a click, from a closing menu or from returning
  // to the window would open a card with no pointer near it to close it.
  const handleTriggerFocus = (event: React.FocusEvent<HTMLElement>) => {
    if (lastInputWasKey) {
      staleIntentRef.current = false;
    } else {
      event.preventDefault();
    }
  };

  // Radix holds a card open while a press that started inside it is down,
  // and schedules no close when that press ends somewhere else.
  const handleContentPointerDown = () => {
    document.addEventListener(
      "pointerup",
      (event) => {
        const target = event.target instanceof Node ? event.target : null;
        const inContent = !!target && !!contentRef.current?.contains(target);
        if (!inContent && !pointerOnTriggerRef.current) release();
      },
      { once: true }
    );
  };

  const handleExpand = () => {
    if (!tabId || !onExpand) return;
    const rect = bodyRef.current?.getBoundingClientRect() ?? null;
    release();
    requestAnimationFrame(() => onExpand(tabId, rect));
  };

  return (
    <HoverCard
      openDelay={SIDEBAR_HOVER_OPEN_DELAY_MS}
      closeDelay={SIDEBAR_HOVER_CLOSE_DELAY_MS}
      open={open}
      onOpenChange={handleOpenChange}
    >
      <HoverCardTrigger
        asChild
        onPointerEnter={handleTriggerPointerEnter}
        onPointerLeave={handleTriggerPointerLeave}
        onFocus={handleTriggerFocus}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        ref={contentRef}
        onPointerDown={handleContentPointerDown}
        variant="tooltip"
        side="right"
        sideOffset={0}
        // With a body, pin the pill beside the row (2px centers a 28px pill
        // on a 32px row) and let the card grow downward from it.
        align={hasBody ? "start" : "center"}
        alignOffset={hasBody ? 2 : 0}
        className={cn(
          preview && "w-72 max-w-none",
          // display:none rather than animate-none, which loses to the
          // exit animation's own rule; Radix unmounts on the cancelled fade.
          handedOff && "data-[state=closed]:hidden"
        )}
      >
        {/* Radix also holds a card open while it contains a text selection,
            so its text is not selectable. */}
        <HoverCardHeader className="flex select-none items-center gap-1.5">
          {title}
          {badge ? (
            <Badge
              variant="inverse"
              className="h-4 px-1 text-[10px] leading-none"
            >
              {badge}
            </Badge>
          ) : null}
        </HoverCardHeader>
        {hasBody ? (
          <HoverCardBody ref={bodyRef} className="select-none">
            {disabledMessage ? (
              <p className="text-xs text-muted-foreground">{disabledMessage}</p>
            ) : null}
            {preview ? (
              <>
                {clipUrl ? (
                  <button
                    type="button"
                    onClick={handleExpand}
                    className="cursor-pointer overflow-hidden rounded-sm bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Open ${preview.title} learn more`}
                  >
                    <video
                      ref={videoRef}
                      src={blobCache[clipUrl] ?? clipUrl}
                      poster={preview.videoThumbnail}
                      className="aspect-video h-auto w-full object-cover"
                      autoPlay
                      loop
                      muted
                      playsInline
                      preload="auto"
                    />
                  </button>
                ) : null}
                <div className="flex items-end justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {preview.description}
                  </p>
                  <button
                    type="button"
                    onClick={handleExpand}
                    className="shrink-0 cursor-pointer rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={`Learn more about ${preview.title}`}
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </>
            ) : null}
          </HoverCardBody>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}
