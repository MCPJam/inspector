import { useRef, useState } from "react";
import { ExternalLink, Inbox } from "lucide-react";
import type { HostConfigMcpProfileV1 } from "@/lib/client-config-v2";
import { previewIframeAllow } from "@/lib/client-preview-iframe-allow";

/**
 * The live published chatbox, embedded, so a scenario can be spot-checked
 * (chrome, welcome copy, tool flow) without leaving the page. Points at the
 * real share URL — the same one "Open" launches.
 *
 * Two things make the embed work at all, and both are easy to break:
 *
 *  - The self-embed is a deliberate exception to the misrouted-pushState
 *    guard in `main.tsx`, which matches on the `/chatbox/<slug>/<token>`
 *    PATHNAME. Query params are fine; a shape change is not.
 *  - `isEmbeddedPreview()` (`lib/embedded-preview.ts`) makes the embedded
 *    runtime skip its sessionStorage writes. Without it the guest session
 *    leaks into the dashboard's own storage and the next reload boots the
 *    inspector into the tester's chatbox.
 *
 * Both guards key off same-origin, which is also the only way an embed can
 * render — a cross-origin share link (desktop builds, where the app isn't
 * served over http(s)) loads the remote app, which then renders its OWN
 * iframe guard. We check the origin here and offer the link instead, rather
 * than framing an error page.
 *
 * KNOWN LIMITATION — the embed is not a faithful guest simulation, in two
 * ways this pane surfaces rather than hides:
 *
 *  - Same-origin means the frame shares the dashboard's WorkOS/Convex auth,
 *    so the runtime redeems the link as the signed-in member, not as an
 *    anonymous tester. Access-mode and sign-in behaviour a real guest hits
 *    are therefore NOT reproduced here. Hence the footnote.
 *  - Authorizing an OAuth-backed MCP server calls `window.location.assign`
 *    (`lib/oauth/mcp-oauth.ts`), which navigates THIS frame to the provider
 *    and returns to `/oauth/callback` — a path the `main.tsx` exemption
 *    deliberately does not cover, so the frame would land on
 *    `IframeRouterError`. We detect the frame leaving the chatbox path and
 *    hand the user back to a real browser tab, where the flow completes.
 *    Making OAuth work in-frame means changing where that redirect goes;
 *    that belongs in its own change, not silently in this one.
 */
export function ChatboxPreviewPane({
  publishLink,
  mcpProfile,
  emptyTitle = "No share link yet",
  emptyBody = "Publish this scenario to get a share link, then come back here to preview it.",
}: {
  publishLink: string | null;
  mcpProfile: HostConfigMcpProfileV1 | undefined;
  emptyTitle?: string;
  emptyBody?: string;
}) {
  const src = publishLink ? buildPreviewSrc(publishLink) : null;

  if (!publishLink) {
    return (
      <PreviewEmptyState title={emptyTitle} body={emptyBody} link={null} />
    );
  }

  if (!src) {
    return (
      <PreviewEmptyState
        title="Preview isn't available here"
        body="This build serves share links from another origin, so the chatbox can't be embedded. Open it in a new tab instead."
        link={publishLink}
      />
    );
  }

  return <PreviewFrame src={src} link={publishLink} mcpProfile={mcpProfile} />;
}

function PreviewFrame({
  src,
  link,
  mcpProfile,
}: {
  src: string;
  link: string;
  mcpProfile: HostConfigMcpProfileV1 | undefined;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [navigatedAway, setNavigatedAway] = useState(false);

  // A document navigation inside the frame (OAuth is the one that happens in
  // practice) fires `load` on a path the runtime never serves. Same-origin, so
  // reading it is allowed; a throw means it went cross-origin, which is just
  // as much "no longer the chatbox".
  const handleLoad = () => {
    try {
      const path = frameRef.current?.contentWindow?.location.pathname;
      setNavigatedAway(!path || !PUBLIC_CHATBOX_RUNTIME_PATH.test(path));
    } catch {
      setNavigatedAway(true);
    }
  };

  if (navigatedAway) {
    return (
      <PreviewEmptyState
        title="This flow can't finish inside the preview"
        body="The scenario navigated away from the chatbox — an OAuth sign-in does this. Open it in a real browser tab to complete the flow."
        link={link}
        onRetry={() => setNavigatedAway(false)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/10">
      <iframe
        // Keyed on the src so a rotated link remounts the runtime rather than
        // leaving the previous token's session on screen.
        key={src}
        ref={frameRef}
        src={src}
        onLoad={handleLoad}
        title="Scenario preview"
        data-testid="user-testing-preview-frame"
        className="size-full flex-1 border-0 bg-background"
        allow={previewIframeAllow(mcpProfile)}
      />
      {/* Not a faithful guest run: the frame shares the dashboard's login. */}
      <p className="shrink-0 border-t border-border/40 px-3 py-1.5 text-[10px] text-muted-foreground">
        Previewing as you, signed in — a tester opening this link gets the
        guest experience, which can differ.
      </p>
    </div>
  );
}

const PUBLIC_CHATBOX_RUNTIME_PATH = /^\/chatbox\/[^/]+\/[^/]+\/?$/;

/**
 * Tag the embedded run as `preview` traffic. The chatbox runtime reads
 * `?surface=` on bootstrap (`readChatboxSurfaceFromUrl`) and carries it onto
 * the session, so sessions started from this pane are distinguishable from a
 * real tester's in Sessions and in analytics. Returns null when the link
 * can't be embedded — unparseable, or a different origin than the app.
 */
function buildPreviewSrc(publishLink: string): string | null {
  try {
    const url = new URL(publishLink, window.location.href);
    if (url.origin !== window.location.origin) return null;
    url.searchParams.set("surface", "preview");
    return url.toString();
  } catch {
    return null;
  }
}

function PreviewEmptyState({
  title,
  body,
  link,
  onRetry,
}: {
  title: string;
  body: string;
  link: string | null;
  onRetry?: () => void;
}) {
  return (
    <div
      className="flex h-full items-center justify-center px-6 text-center"
      data-testid="user-testing-preview-empty"
    >
      <div className="max-w-sm">
        <Inbox className="mx-auto size-8 text-muted-foreground/70" />
        <p className="mt-3 text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{body}</p>
        <div className="mt-3 flex items-center justify-center gap-4">
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              <ExternalLink className="size-3.5" />
              Open in a new tab
            </a>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
            >
              Reload preview
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
