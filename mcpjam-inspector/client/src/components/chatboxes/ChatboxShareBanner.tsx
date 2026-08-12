/**
 * Share affordances for a User Testing scenario.
 *
 * - {@link ChatboxShareBanner} — compact strip in the detail header.
 * - {@link ChatboxShareEmptyPanel} — centered empty-state panel for Insights
 *   (same copy / invite / copy-link actions, different composition).
 *
 * Full access / invite management lives on the Edit route
 * ({@link ChatboxShareSection}).
 */
import { useState } from "react";
import { ExternalLink, Link2, Mail } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  type ChatboxSettings,
  useChatboxMutations,
} from "@/hooks/useChatboxes";
import { buildChatboxLink } from "@/lib/chatbox-session";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const INVITE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function useChatboxShareInvite(chatbox: ChatboxSettings) {
  const { upsertChatboxMember } = useChatboxMutations();
  const [email, setEmail] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [isInviting, setIsInviting] = useState(false);

  const shareLink = chatbox.link?.token
    ? buildChatboxLink(chatbox.link.token, chatbox.name)
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
    if (!normalizedEmail || emailInvalid) return;
    setIsInviting(true);
    try {
      await upsertChatboxMember({
        chatboxId: chatbox.chatboxId,
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
  triggerClassName,
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
  triggerClassName?: string;
}) {
  return (
    <Popover open={inviteOpen} onOpenChange={setInviteOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("rounded-lg", triggerClassName)}
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
          <p className="text-xs text-destructive">Enter a valid email address.</p>
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
  inviteTriggerClassName,
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
  inviteTriggerClassName?: string;
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
          triggerClassName={inviteTriggerClassName}
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

export function ChatboxShareBanner({
  chatbox,
}: {
  chatbox: ChatboxSettings;
}) {
  const { isAuthenticated } = useConvexAuth();
  const share = useChatboxShareInvite(chatbox);

  if (!isAuthenticated) return null;

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid="user-testing-share-banner"
    >
      <div className="min-w-0 space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-primary">
          Share this with customers
        </p>
        <p
          className="truncate font-mono text-sm text-foreground"
          title={share.shareLink ?? undefined}
        >
          {share.displayLink ?? "No share link yet."}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          They open it in the selected client and work through tasks against
          your live server.
        </p>
      </div>
      <ShareActions id="user-testing-share" showInvite {...share} />
    </div>
  );
}

/**
 * Insights empty state: the share message as the workbench's main content,
 * not a second header strip.
 */
export function ChatboxShareEmptyPanel({
  chatbox,
}: {
  chatbox: ChatboxSettings;
}) {
  const { isAuthenticated } = useConvexAuth();
  const share = useChatboxShareInvite(chatbox);
  // Same gate as the header Open preview: a broken environment won't open
  // for testers either, so framing it here would only mislead.
  const canOpenPreview = Boolean(share.shareLink && !chatbox.environmentError);

  return (
    <div
      className="flex h-full flex-col items-center justify-center px-4"
      data-testid="user-testing-share-empty"
    >
      <div className="w-full max-w-xl rounded-2xl border border-primary/20 bg-gradient-to-b from-primary/[0.07] to-primary/[0.02] px-7 py-9 text-center shadow-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
          Share this with customers
        </p>
        <p
          className="mt-4 break-all font-mono text-[15px] leading-snug text-foreground sm:text-base"
          title={share.shareLink ?? undefined}
        >
          {share.displayLink ?? "No share link yet."}
        </p>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
          They open it in the selected client and work through tasks against
          your live server.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
          <ShareActions
            id="user-testing-share-empty"
            showInvite={isAuthenticated}
            inviteTriggerClassName="bg-background/60 hover:bg-background"
            {...share}
          />
          {canOpenPreview ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-lg bg-background/60 hover:bg-background"
              asChild
            >
              <a
                href={share.shareLink!}
                target="_blank"
                rel="noreferrer"
                data-testid="user-testing-share-empty-preview"
              >
                <ExternalLink className="mr-1.5 size-3.5" />
                Open preview
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
