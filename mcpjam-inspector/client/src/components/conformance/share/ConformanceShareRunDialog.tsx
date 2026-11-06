/**
 * Share for one saved conformance run: the run's score card, with Download
 * PNG, Copy link, and posts to X and LinkedIn.
 *
 * The posts share the run's link, not the image: the link's page carries the
 * same card as its og:image (see server/utils/conformance-share-meta-tags.ts),
 * so X and LinkedIn unfurl it as the card — but only while anyone may open the
 * link. Who may is the existing access dialog, one click away.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useConvexAuth } from "convex/react";
import { Download, Link2, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { ShareDialog } from "@/components/sharing/ShareDialog";
import { ResourceSharePanel } from "@/components/sharing/ResourceSharePanel";
import type { ShareMode } from "@/components/sharing/share-types";
import { useShareSettings } from "@/hooks/useShares";
import { useArtifactQuery } from "@/lib/artifact-urls";
import { buildConformanceSharePath } from "@/lib/app-navigation";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
} from "@/shared/conformance-share-card";
import {
  ShareCardPreview,
  exportShareCardPng,
  useShareCardSvg,
} from "./ShareCardPreview";
import {
  linkedInShareUrl,
  shareCardDataFromRun,
  shareCardFileName,
  sharePostText,
  xShareUrl,
  type ShareableRunDetail,
} from "./share-run-content";

function XLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4 fill-current">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function LinkedInLogo() {
  return (
    <span aria-hidden className="text-[15px] leading-none font-bold">
      in
    </span>
  );
}

const ROW =
  "flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50";

function ActionRow({
  icon,
  title,
  subtitle,
  onClick,
  disabled,
  primary = false,
  testId,
}: {
  icon: ReactNode;
  title: string;
  subtitle: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`${ROW} ${
        primary
          ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/90"
          : "border-border bg-background hover:bg-accent"
      }`}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span
          className={`block text-xs ${
            primary ? "text-primary-foreground/85" : "text-muted-foreground"
          }`}
        >
          {subtitle}
        </span>
      </span>
    </button>
  );
}

/** Why a post will not show the card, when the link is not open to all. */
function restrictedLinkNote(mode: ShareMode | undefined): string | null {
  if (!mode || mode === "anyone_with_link") return null;
  const who =
    mode === "invited_only" ? "Only people you invite" : "Only team members";
  return `${who} can open this link, so X and LinkedIn won't show the card.`;
}

function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function ShareRunBody({
  runId,
  serverName,
  onEditAccess,
}: {
  runId: string;
  serverName?: string;
  onEditAccess: () => void;
}) {
  const { isAuthenticated } = useConvexAuth();
  const run = useArtifactQuery<ShareableRunDetail | null>(
    "conformanceRuns:getRun",
    { runId },
  );
  const { settings } = useShareSettings({
    isAuthenticated,
    resourceType: "conformanceRun",
    resourceId: runId,
  });
  const [saving, setSaving] = useState(false);

  const data = useMemo(
    () =>
      run
        ? shareCardDataFromRun(run, {
            serverName,
            siteLabel: window.location.hostname,
          })
        : null,
    [run, serverName],
  );
  const svg = useShareCardSvg(data);
  const token = settings?.link?.token;
  const shareUrl = token
    ? `${window.location.origin}${buildConformanceSharePath(token)}`
    : null;
  const note = shareUrl ? restrictedLinkNote(settings?.mode) : null;

  const download = async () => {
    if (!svg || !data) return;
    setSaving(true);
    try {
      const href = URL.createObjectURL(await exportShareCardPng(svg));
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = shareCardFileName(data);
      anchor.click();
      // Long enough for the download to start before the URL goes away.
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
    } catch {
      toast.error("Couldn't save the image. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const copyLink = async () => {
    if (!shareUrl) return;
    if (await copyToClipboard(shareUrl)) toast.success("Link copied");
    else toast.error("Couldn't copy the link. Try again.");
  };

  return (
    <div className="flex flex-col gap-3">
      {run === undefined ? (
        <div
          className="w-full animate-pulse rounded-lg bg-muted"
          style={{ aspectRatio: `${SHARE_CARD_WIDTH} / ${SHARE_CARD_HEIGHT}` }}
          role="status"
          aria-label="Loading the score card"
        />
      ) : data ? (
        <ShareCardPreview data={data} svg={svg} />
      ) : (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          {run === null
            ? "This run is missing or you no longer have access."
            : "This run has no applicable checks, so it has no score card."}
        </p>
      )}

      <ActionRow
        primary
        icon={
          saving ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Download className="size-4" aria-hidden />
          )
        }
        title="Download PNG"
        subtitle="Save this card as an image."
        onClick={() => void download()}
        disabled={!svg || saving}
        testId="conformance-share-download"
      />

      {/* A stretched button, so "Edit access settings" can sit inside the row
          without nesting one button in another. */}
      <div
        className={`${ROW} relative border-border bg-background hover:bg-accent ${
          shareUrl ? "" : "opacity-90"
        }`}
      >
        <button
          type="button"
          className="absolute inset-0 rounded-lg disabled:cursor-not-allowed"
          onClick={() => void copyLink()}
          disabled={!shareUrl}
          aria-label="Copy link"
          data-testid="conformance-share-copy-link"
        />
        <span className="flex size-5 shrink-0 items-center justify-center">
          <Link2 className="size-4" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium">Copy link</span>
          <span className="block text-xs text-muted-foreground">
            {shareUrl
              ? "Share a link to these conformance results. "
              : "There is no link yet. "}
            <button
              type="button"
              className="relative z-10 text-primary underline-offset-2 hover:underline"
              onClick={onEditAccess}
              data-testid="conformance-share-edit-access"
            >
              Edit access settings.
            </button>
          </span>
          {note ? (
            <span
              className="mt-1 block text-xs text-amber-700 dark:text-amber-400"
              data-testid="conformance-share-restricted-note"
            >
              {note}
            </span>
          ) : null}
        </span>
      </div>

      <ActionRow
        icon={<XLogo />}
        title="Post to X"
        subtitle="Open X and share your results."
        onClick={() =>
          data &&
          shareUrl &&
          openExternal(xShareUrl(sharePostText(data), shareUrl))
        }
        disabled={!data || !shareUrl}
        testId="conformance-share-post-x"
      />
      <ActionRow
        icon={<LinkedInLogo />}
        title="Post to LinkedIn"
        subtitle="Open LinkedIn and share your results."
        onClick={() => shareUrl && openExternal(linkedInShareUrl(shareUrl))}
        disabled={!data || !shareUrl}
        testId="conformance-share-post-linkedin"
      />
    </div>
  );
}

export function ConformanceShareRunDialog({
  runId,
  serverName,
  open,
  onOpenChange,
  finished,
}: {
  runId: string;
  serverName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finished: boolean;
}) {
  const [accessOpen, setAccessOpen] = useState(false);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]"
          data-testid="conformance-share-dialog"
        >
          <DialogHeader>
            <DialogTitle>Share conformance run</DialogTitle>
            <DialogDescription>
              Download the image, post it, or copy a public link.
            </DialogDescription>
          </DialogHeader>
          <ShareRunBody
            runId={runId}
            serverName={serverName}
            onEditAccess={() => {
              onOpenChange(false);
              setAccessOpen(true);
            }}
          />
        </DialogContent>
      </Dialog>
      {/* The access dialog that Share used to open directly. Closing it goes
          back to the card, where the link is now copyable or postable. */}
      <ShareDialog
        open={accessOpen}
        onOpenChange={(next) => {
          setAccessOpen(next);
          if (!next) onOpenChange(true);
        }}
        title="Access settings"
        description="Who can open this run's link. Viewers see a redacted snapshot."
      >
        <ResourceSharePanel
          resourceType="conformanceRun"
          resourceId={runId}
          disabledReason={finished ? null : "Only a finished run can be shared"}
          footerSlot={
            <p className="text-xs text-muted-foreground">
              Viewers see a frozen snapshot. Revoking access takes effect
              immediately.
            </p>
          }
          linkLabel="Share link"
          buildShareUrl={(token) =>
            `${window.location.origin}${buildConformanceSharePath(token)}`
          }
          testIdPrefix="conformance-share"
          invites={false}
        />
      </ShareDialog>
    </>
  );
}
