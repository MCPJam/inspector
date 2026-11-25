import { useEffect, useState } from "react";
import { Download, Link2, Share2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { buildCaniuseCapabilityPath } from "./caniuse-capability-catalog";
import {
  eventsSupportSummary,
  sliceLabel,
  type CapabilityCoverage,
} from "./caniuse-coverage";
import {
  CARD_WIDTH,
  CARD_HEIGHT,
  drawCaniuseReportCard,
} from "./caniuse-report-card";

export function buildCapabilityShareUrl(slug: string, slice: string) {
  const url = new URL(buildCaniuseCapabilityPath(slug), "https://caniuse.dev");
  if (slice && slice !== "any") url.searchParams.set("slice", slice);
  return url.href;
}

export function CaniuseShareDialog({
  title,
  slug,
  slice,
  coverage,
}: {
  title: string;
  slug: string;
  slice: string;
  coverage: CapabilityCoverage;
}) {
  const [open, setOpen] = useState(false);
  const [imageState, setImageState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [feedback, setFeedback] = useState("");
  const [showLink, setShowLink] = useState(false);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const url = buildCapabilityShareUrl(slug, slice);
  const label = sliceLabel(coverage.eventsMode ?? slice);
  const post = [
    title,
    label,
    coverage.score === null
      ? "No published client results yet"
      : coverage.eventsMode
        ? eventsSupportSummary(coverage)
        : `${coverage.score}% ${coverage.reporting ? "reporting coverage" : "client adoption"}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const x = new URL("https://x.com/intent/tweet");
  x.search = new URLSearchParams({ text: post, url }).toString();
  const linkedin = new URL("https://www.linkedin.com/sharing/share-offsite/");
  linkedin.searchParams.set("url", url);

  useEffect(() => {
    if (!open || !canvas) return;
    const controller = new AbortController();
    setImageState("loading");
    void drawCaniuseReportCard(canvas, title, label, coverage, controller.signal).then(
      () => {
        if (!controller.signal.aborted) setImageState("ready");
      },
      () => {
        if (!controller.signal.aborted) setImageState("error");
      },
    );
    return () => controller.abort();
  }, [open, canvas, title, label, coverage]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setFeedback("Link copied.");
    } catch {
      setShowLink(true);
      setFeedback("Select the link to copy it.");
    }
  }

  function download() {
    canvas?.toBlob((blob) => {
      if (!blob) {
        setFeedback("Could not download the card. Try again.");
        return;
      }
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `caniuse-${slug}${slice && slice !== "any" ? `-${slice}` : ""}.png`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    }, "image/png");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setImageState("loading");
          setFeedback("");
          setShowLink(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0">
          <Share2 className="size-4" /> Share
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="dark caniuse-dialog max-h-[calc(100dvh-2rem)] overflow-auto border-0 bg-card text-card-foreground sm:max-w-[680px]"
      >
        <DialogTitle>Share capability</DialogTitle>
        <div className="relative aspect-[1200/630] overflow-hidden rounded-lg bg-background">
          <canvas
            ref={setCanvas}
            width={CARD_WIDTH}
            height={CARD_HEIGHT}
            className="block h-auto w-full"
            role="img"
            aria-label={post}
          />
          {imageState !== "ready" && (
            <p
              role="status"
              className="absolute inset-0 grid place-items-center bg-background px-4 text-center text-sm text-muted-foreground"
            >
              {imageState === "loading"
                ? "Preparing the report card…"
                : "Could not generate the card. Close Share and try again."}
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Button size="sm" onClick={copyLink}>
            <Link2 className="size-4" /> Copy link
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={x.href} target="_blank" rel="noreferrer">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-7.2L5.7 22H2.5l7.3-8.4L2 2h6.3l4.4 6.6L18.9 2Zm-1.1 18h1.7L7.3 3.9H5.5L17.8 20Z" />
              </svg>{" "}
              Post to X
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={linkedin.href} target="_blank" rel="noreferrer">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6.5 8.3H3.2V21h3.3V8.3ZM4.9 2.9a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM21 13.7c0-3.8-2-5.7-4.7-5.7-2.2 0-3.2 1.2-3.7 2V8.3H9.3V21h3.3v-6.9c0-1.9.9-2.9 2.4-2.9 1.4 0 2.1 1 2.1 2.9V21H21v-7.3Z" />
              </svg>{" "}
              Post to LinkedIn
            </a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={download}
            disabled={imageState !== "ready"}
          >
            <Download className="size-4" /> Download image
          </Button>
        </div>
        {feedback && (
          <p role="status" className="text-sm text-muted-foreground">
            {feedback}
          </p>
        )}
        {showLink && (
          <Input
            readOnly
            aria-label="Capability link"
            value={url}
            onFocus={(event) => event.target.select()}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
