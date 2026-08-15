/**
 * Share affordances for a User Testing scenario.
 *
 * - {@link ScenarioShareBanner} — compact strip in the detail header.
 * - {@link ScenarioShareEmptyPanel} — the Insights empty state, which offers
 *   the same invite / copy-link actions plus a self-serve run, and does NOT
 *   restate the banner's headline copy.
 *
 * Full access / invite management lives on the Edit route
 * ({@link ScenarioShareSection}).
 */
import { useState } from "react";
import { ArrowUp, Link2, Mail } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  type ScenarioSettings,
  useScenarioMutations,
} from "@/hooks/useScenarios";
import { buildScenarioLink } from "@/lib/scenario-session";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const INVITE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * What stands in for the URL. "No share link yet" is only true before one has
 * been minted — saying it while a link exists but is withheld reads as a
 * missing feature rather than a scenario the author needs to fix.
 */
function withheldOrAbsentLinkLabel(scenario: ScenarioSettings): string {
  if (scenario.link?.token && scenario.environmentError) {
    return "Withheld — this scenario can't run.";
  }
  return "No share link yet.";
}

function useScenarioShareInvite(scenario: ScenarioSettings) {
  const { upsertScenarioMember } = useScenarioMutations();
  const [email, setEmail] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [isInviting, setIsInviting] = useState(false);

  // Withheld on the same condition `ScenarioShareSection` withholds it: a
  // scenario whose environment doesn't resolve won't open for a tester, so
  // handing the link out here made the two surfaces disagree — the Edit tab
  // refused to give the link while this strip copied it out anyway. Nothing is
  // rotated or revoked; the token returns when the scenario can run again.
  const shareLink =
    scenario.link?.token && !scenario.environmentError
      ? buildScenarioLink(scenario.link.token, scenario.name)
      : null;
  const displayLink = shareLink?.replace(/^https?:\/\//, "") ?? null;
  const normalizedEmail = email.trim().toLowerCase();
  const emailInvalid =
    Boolean(normalizedEmail) && !INVITE_EMAIL_PATTERN.test(normalizedEmail);

  const handleCopyLink = async () => {
    if (!shareLink) return;
    const ok = await copyToClipboard(shareLink);
    if (ok) toast.success("Link copied");
    else toast.error("Failed to copy share link");
  };

  const handleInvite = async () => {
    if (!normalizedEmail || emailInvalid || isInviting) return;
    setIsInviting(true);
    try {
      await upsertScenarioMember({
        scenarioId: scenario.scenarioId,
        email: normalizedEmail,
        sendInviteEmail: true,
      });
      setEmail("");
      setInviteOpen(false);
      toast.success(`Invited ${normalizedEmail}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to invite");
    } finally {
      setIsInviting(false);
    }
  };

  return {
    shareLink,
    displayLink,
    email,
    setEmail,
    inviteOpen,
    setInviteOpen,
    isInviting,
    normalizedEmail,
    emailInvalid,
    handleCopyLink,
    handleInvite,
  };
}

function InviteByEmailControl({
  id,
  email,
  setEmail,
  inviteOpen,
  setInviteOpen,
  isInviting,
  normalizedEmail,
  emailInvalid,
  handleInvite,
}: {
  id: string;
  email: string;
  setEmail: (value: string) => void;
  inviteOpen: boolean;
  setInviteOpen: (open: boolean) => void;
  isInviting: boolean;
  normalizedEmail: string;
  emailInvalid: boolean;
  handleInvite: () => void;
}) {
  return (
    <Popover open={inviteOpen} onOpenChange={setInviteOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="rounded-lg"
          data-testid={`${id}-invite`}
        >
          <Mail className="mr-1.5 size-3.5" />
          Invite by email
        </Button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-80 space-y-2 p-3">
        <label className="text-sm font-medium" htmlFor={`${id}-email`}>
          Invite with email
        </label>
        <div className="flex gap-2">
          <Input
            id={`${id}-email`}
            type="email"
            placeholder="name@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleInvite();
              }
            }}
            aria-invalid={emailInvalid || undefined}
            aria-describedby={emailInvalid ? `${id}-email-error` : undefined}
            className="h-8"
          />
          <Button
            type="button"
            size="sm"
            disabled={!normalizedEmail || emailInvalid || isInviting}
            onClick={() => void handleInvite()}
          >
            {isInviting ? "…" : "Invite"}
          </Button>
        </div>
        {emailInvalid ? (
          <p
            id={`${id}-email-error`}
            role="alert"
            className="text-xs text-destructive"
          >
            Enter a valid email address.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ShareActions({
  id,
  shareLink,
  email,
  setEmail,
  inviteOpen,
  setInviteOpen,
  isInviting,
  normalizedEmail,
  emailInvalid,
  handleCopyLink,
  handleInvite,
  showInvite,
  className,
}: {
  id: string;
  shareLink: string | null;
  email: string;
  setEmail: (value: string) => void;
  inviteOpen: boolean;
  setInviteOpen: (open: boolean) => void;
  isInviting: boolean;
  normalizedEmail: string;
  emailInvalid: boolean;
  handleCopyLink: () => void;
  handleInvite: () => void;
  showInvite: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex shrink-0 flex-wrap items-center gap-2", className)}>
      {showInvite ? (
        <InviteByEmailControl
          id={id}
          email={email}
          setEmail={setEmail}
          inviteOpen={inviteOpen}
          setInviteOpen={setInviteOpen}
          isInviting={isInviting}
          normalizedEmail={normalizedEmail}
          emailInvalid={emailInvalid}
          handleInvite={handleInvite}
        />
      ) : null}
      <Button
        type="button"
        size="sm"
        className="rounded-lg"
        disabled={!shareLink}
        onClick={() => void handleCopyLink()}
        data-testid={`${id}-copy`}
      >
        <Link2 className="mr-1.5 size-3.5" />
        Copy link
      </Button>
    </div>
  );
}

export function ScenarioShareBanner({
  scenario,
}: {
  scenario: ScenarioSettings;
}) {
  const { isAuthenticated } = useConvexAuth();
  const share = useScenarioShareInvite(scenario);

  if (!isAuthenticated) return null;

  return (
    /* Neutral surface, not the primary tint this used to wear. Handing someone
       a link is routine; a coloured border under an already busy header read as
       a warning about the scenario rather than a tool for sharing it. */
    <div
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl border border-border/60 bg-muted/30 px-4 py-2.5"
      data-testid="user-testing-share-banner"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 text-xs font-medium text-muted-foreground">
          Tester link
        </span>
        {/* The URL is this strip's subject, so it is also its affordance:
            clicking it copies. The explicit button stays — a bare string
            does not announce itself as clickable, and losing the primary
            action to a guess would be a worse trade than the redundancy. */}
        <button
          type="button"
          disabled={!share.shareLink}
          onClick={() => void share.handleCopyLink()}
          title={share.shareLink ?? undefined}
          aria-label={
            share.shareLink ? `Copy tester link ${share.displayLink}` : undefined
          }
          className={cn(
            "min-w-0 truncate rounded-md px-1.5 py-0.5 font-mono text-sm text-foreground",
            "transition-colors hover:bg-foreground/[0.06]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:pointer-events-none disabled:text-muted-foreground",
          )}
          data-testid="user-testing-share-link"
        >
          {share.displayLink ?? withheldOrAbsentLinkLabel(scenario)}
        </button>
      </div>
      <ShareActions id="user-testing-share" showInvite {...share} />
    </div>
  );
}

/**
 * Insights empty state — the two ways to get a first session, in the order
 * they cost the reader: run it yourself, or send it to a tester.
 *
 * The detail page hides the header share strip while this panel is up, so
 * share lives here alone until the first session arrives.
 *
 * The composer is a LINK dressed as a chat input, not an input. Typing into a
 * real field whose text we then discard (the guest runtime takes no prefill)
 * would be a lie the second character exposes; a door shaped like the room
 * behind it is not.
 */
export function ScenarioShareEmptyPanel({
  scenario,
}: {
  scenario: ScenarioSettings;
}) {
  const { isAuthenticated } = useConvexAuth();
  const share = useScenarioShareInvite(scenario);
  // `shareLink` is already withheld while the environment can't resolve, so
  // this is the same gate the header Open preview uses.
  const canOpenPreview = Boolean(share.shareLink);

  return (
    <div
      className="flex h-full flex-col overflow-y-auto px-6 py-10"
      data-testid="user-testing-share-empty"
    >
      {/* `my-auto` rather than `justify-center`: a centered flex child in a
          scroll container has its overflow clipped off the TOP, unreachable. */}
      <div className="mx-auto my-auto w-full max-w-lg animate-in fade-in duration-500">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          Insights start with the first session.
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          Once someone runs this scenario, this page maps where they reached
          their goal, where they stalled, and the themes that repeat across
          sessions.
        </p>

        {canOpenPreview ? (
          <>
            <div className="group relative mt-6">
              {/* Warmth on approach, not at rest — a permanent glow would
                  just tint the page the way the old panel did. */}
              <div
                aria-hidden
                className="pointer-events-none absolute -inset-3 rounded-[1.75rem] bg-primary/[0.07] opacity-0 blur-xl transition-opacity duration-300 group-hover:opacity-100"
              />
              <a
                href={share.shareLink!}
                target="_blank"
                rel="noreferrer"
                aria-label="Try the scenario yourself — opens the live scenario in a new tab"
                data-testid="user-testing-share-empty-preview"
                className={cn(
                  "relative flex w-full items-center gap-3 rounded-2xl border border-border/70 bg-card px-4 py-3.5 shadow-sm",
                  "transition-all duration-200 hover:border-primary/40 hover:shadow-md",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  Try it yourself — ask it something
                  <span
                    aria-hidden
                    className="ml-1 inline-block h-[1.05em] w-px translate-y-[0.2em] bg-primary animate-[blink_1.15s_ease-in-out_infinite]"
                  />
                </span>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform duration-200 group-hover:scale-105">
                  <ArrowUp className="size-4" />
                </span>
              </a>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">
              Opens the live scenario in a new tab. Your run lands here like any
              tester&apos;s.
            </p>
          </>
        ) : (
          <p
            className="mt-6 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground"
            data-testid="user-testing-share-empty-blocked"
          >
            {scenario.link?.token && scenario.environmentError
              ? "This scenario can't be opened right now — its environment isn't resolving, so the link won't load for you or a tester."
              : "No share link yet."}
          </p>
        )}

        <div className="my-7 flex items-center gap-3">
          <span className="h-px flex-1 bg-border/60" />
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
            or send it to a tester
          </span>
          <span className="h-px flex-1 bg-border/60" />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className="min-w-0 flex-1 basis-full truncate rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 font-mono text-xs text-muted-foreground sm:basis-0"
            title={share.shareLink ?? undefined}
          >
            {share.displayLink ?? withheldOrAbsentLinkLabel(scenario)}
          </span>
          <ShareActions
            id="user-testing-share-empty"
            showInvite={isAuthenticated}
            {...share}
          />
        </div>
      </div>
    </div>
  );
}
