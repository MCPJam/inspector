import { Globe } from "lucide-react";

/**
 * What a new tab shows.
 *
 * A PICTURE, not a page. The tab behind this is `about:blank` and this is
 * drawn by the shell on top of it, which is the whole reason it exists in this
 * form: a start page served from the inspector would be a real document with
 * this app's origin, sitting inside a browser an agent is driving — navigable,
 * readable, and with a URL somebody could be persuaded to trust. A blank tab
 * with a caption over it has none of those properties and looks the same.
 *
 * MINIMAL, and deliberately so. Every start page anybody has shipped grows
 * into a dashboard: shortcuts, recent sites, a search box. Search is
 * explicitly out of scope here — quietly shipping what somebody types to a
 * third party is a default nobody chose — and the rest is a surface with no
 * audience, because a person opens a tab in THIS browser to go to one specific
 * place, usually a localhost port they already have in their head.
 *
 * So: one sentence saying what to do, and nothing to click. The address field
 * above is the control; pointing at it is the whole job.
 */
export function BrowserStartPage() {
  return (
    <div
      data-testid="browser-start-page"
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background px-6 text-center"
    >
      <Globe className="size-7 text-muted-foreground/60" aria-hidden />
      <p className="text-sm font-medium text-foreground">New tab</p>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
        Type an address above to go somewhere — a site, or a{" "}
        {/* The one example worth giving, because it is what this browser is
            mostly pointed at and the form people most doubt will work. */}
        <span className="font-mono text-[11px]">localhost:3000</span> you are
        running.
      </p>
    </div>
  );
}
