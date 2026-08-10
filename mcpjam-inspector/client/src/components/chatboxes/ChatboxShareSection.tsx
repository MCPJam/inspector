import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Clock, Globe, Link2, Lock, Users } from "lucide-react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { toast } from "@/lib/toast";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import {
  type ChatboxMember,
  type ChatboxSettings,
  useChatboxMutations,
} from "@/hooks/useChatboxes";
import { buildChatboxLink } from "@/lib/chatbox-session";
import { copyToClipboard } from "@/lib/clipboard";
import { getInitials } from "@/lib/utils";
import {
  chatboxAccessPresetFromSettings,
  settingsFromChatboxAccessPreset,
  type ChatboxAccessPreset,
} from "@/lib/chatbox-access-presets";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@mcpjam/design-system/avatar";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";

const INVITE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ChatboxShareSectionProps {
  chatbox: ChatboxSettings;
  onUpdated?: (chatbox: ChatboxSettings) => void;
  /** Shown as the project-wide access option label (e.g. current project name). */
  projectName?: string | null;
}

export function ChatboxShareSection({
  chatbox,
  onUpdated,
  projectName,
}: ChatboxShareSectionProps) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const { profilePictureUrl } = useProfilePicture();
  const { setChatboxMode, upsertChatboxMember, removeChatboxMember } =
    useChatboxMutations();

  const [settings, setSettings] = useState<ChatboxSettings>(chatbox);
  const [email, setEmail] = useState("");
  const [isInviting, setIsInviting] = useState(false);
  const [isModeBusy, setIsModeBusy] = useState(false);
  const [isMemberBusy, setIsMemberBusy] = useState(false);

  useEffect(() => {
    setSettings(chatbox);
  }, [chatbox]);

  const projectLabel = projectName?.trim() || "Project";

  const accessPreset = chatboxAccessPresetFromSettings(
    settings.mode,
    settings.allowGuestAccess,
  );

  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "You";
  const displayInitials = getInitials(displayName);
  const selfEmailLower = user?.email?.toLowerCase() ?? "";

  const { acceptedInvitees, pendingInvitees } = useMemo(() => {
    const active = settings.members.filter((m) => !m.revokedAt);
    const accepted = active.filter((m) => Boolean(m.userId));
    const pending = active.filter((m) => !m.userId);
    return { acceptedInvitees: accepted, pendingInvitees: pending };
  }, [settings.members]);

  const otherAccepted = useMemo(
    () =>
      acceptedInvitees.filter((m) => m.email.toLowerCase() !== selfEmailLower),
    [acceptedInvitees, selfEmailLower],
  );

  const normalizedEmail = email.trim().toLowerCase();
  const emailValidationError =
    normalizedEmail && !INVITE_EMAIL_PATTERN.test(normalizedEmail)
      ? "Enter a valid email address."
      : null;

  const updateSettings = (next: ChatboxSettings) => {
    setSettings(next);
    onUpdated?.(next);
  };

  const handleAccessPresetChange = async (preset: ChatboxAccessPreset) => {
    if (preset === accessPreset) return;

    const target = settingsFromChatboxAccessPreset(preset);
    setIsModeBusy(true);
    try {
      let next = settings;
      if (target.mode !== settings.mode) {
        next = (await setChatboxMode({
          chatboxId: settings.chatboxId,
          mode: target.mode,
        })) as ChatboxSettings;
      }
      updateSettings(next);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update access settings",
      );
    } finally {
      setIsModeBusy(false);
    }
  };

  const handleInvite = async () => {
    if (!normalizedEmail || emailValidationError) return;

    setIsInviting(true);
    try {
      const next = (await upsertChatboxMember({
        chatboxId: settings.chatboxId,
        email: normalizedEmail,
        sendInviteEmail: true,
      })) as ChatboxSettings;
      updateSettings(next);
      setEmail("");
      toast.success(`Invited ${normalizedEmail}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to invite");
    } finally {
      setIsInviting(false);
    }
  };

  const handleRemoveMember = async (member: ChatboxMember) => {
    setIsMemberBusy(true);
    try {
      const next = (await removeChatboxMember({
        chatboxId: settings.chatboxId,
        memberIdOrEmail: member.email,
      })) as ChatboxSettings;
      updateSettings(next);
      toast.success(`Removed ${member.email}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove member",
      );
    } finally {
      setIsMemberBusy(false);
    }
  };

  const accessTriggerSummary = () => {
    switch (accessPreset) {
      case "project":
        return projectLabel;
      case "invited_only":
        return "Invited users only";
      case "link_guests":
        return "Anyone with the link (guests included)";
    }
  };

  const AccessIcon =
    accessPreset === "project"
      ? Users
      : accessPreset === "link_guests"
        ? Globe
        : Lock;

  const shareLink = settings.link?.token
    ? buildChatboxLink(settings.link.token, settings.name)
    : null;
  const displayLink = shareLink?.replace(/^https?:\/\//, "") ?? null;

  const handleCopyLink = async () => {
    if (!shareLink) return;
    const ok = await copyToClipboard(shareLink);
    if (ok) toast.success("Link copied");
    else toast.error("Failed to copy share link");
  };

  if (!isAuthenticated) {
    return (
      <p className="pt-4 text-sm text-muted-foreground">
        Sign in to manage scenario access.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="chatbox-tester-link">
          Tester link
        </label>
        <div className="flex gap-2">
          {/* `output` rather than a div: the label above needs a LABELABLE
              control to point at, and this is a read-only value, not an input. */}
          <output
            id="chatbox-tester-link"
            className="flex min-w-0 flex-1 items-center rounded-md border border-input bg-muted/30 px-3 py-2"
            title={shareLink ?? undefined}
          >
            <span className="truncate text-sm text-muted-foreground">
              {displayLink ?? "No share link yet."}
            </span>
          </output>
          <Button
            type="button"
            variant="outline"
            disabled={!shareLink}
            onClick={() => void handleCopyLink()}
            data-testid="chatbox-copy-tester-link"
          >
            <Link2 className="mr-1.5 size-4" />
            Copy link
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="chatbox-share-email">
          Invite with email
        </label>
        <div className="flex gap-2">
          <div className="flex flex-1 items-center rounded-md border border-input focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
            <Input
              id="chatbox-share-email"
              type="email"
              placeholder="Add people, emails..."
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleInvite();
                }
              }}
              aria-invalid={emailValidationError ? true : undefined}
              className="flex-1 border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
          <Button
            onClick={() => void handleInvite()}
            disabled={!normalizedEmail || !!emailValidationError || isInviting}
          >
            {isInviting ? "..." : "Invite"}
          </Button>
        </div>
        {emailValidationError ? (
          <p className="text-sm text-destructive">{emailValidationError}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Access settings</label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              disabled={isModeBusy}
            >
              <AccessIcon className="size-4 shrink-0" />
              <span className="flex-1 text-left">{accessTriggerSummary()}</span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-[--radix-dropdown-menu-trigger-width]"
          >
            <DropdownMenuRadioGroup
              value={accessPreset}
              onValueChange={(v) =>
                void handleAccessPresetChange(v as ChatboxAccessPreset)
              }
            >
              {/* Ordered by how a scenario is usually shared: a named tester
                  first, the open link second, the whole project last. */}
              <DropdownMenuRadioItem
                value="invited_only"
                className="items-start"
              >
                <div>
                  <div className="flex items-center gap-2 font-medium">
                    <Lock className="size-4" />
                    Invited users only
                  </div>
                  <p className="text-xs font-normal text-muted-foreground">
                    Only people you invite by email can open this scenario.
                  </p>
                </div>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                value="link_guests"
                className="items-start"
              >
                <div>
                  <div className="flex items-center gap-2 font-medium">
                    <Globe className="size-4" />
                    Anyone with the link (guests included)
                  </div>
                  <p className="text-xs font-normal text-muted-foreground">
                    Anyone with the link can open the scenario, including
                    guests without an account.
                  </p>
                </div>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="project" className="items-start">
                <div>
                  <div className="flex items-center gap-2 font-medium">
                    <Users className="size-4" />
                    {projectLabel}
                  </div>
                  <p className="text-xs font-normal text-muted-foreground">
                    Signed-in members of this project can open the scenario
                    with the link. Guests cannot.
                  </p>
                </div>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Guests run the same environment a member does — computer, skills,
            harness — on the organization's credits, bounded by the platform
            daily caps. Say so where the exposure is created rather than
            burying it in a settings panel. */}
        {accessPreset === "link_guests" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Guest usage runs on your organization&apos;s credits. Guests are
            people who open the link without being invited.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Has access</label>
        <div className="max-h-[300px] space-y-1 overflow-y-auto">
          <div className="flex items-center gap-3 rounded-md p-2">
            <Avatar className="size-9">
              <AvatarImage src={profilePictureUrl} alt={displayName} />
              <AvatarFallback className="text-sm">
                {displayInitials}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-medium">{displayName}</p>
                <span className="text-xs text-muted-foreground">(you)</span>
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {user?.email}
              </p>
            </div>
            <span className="shrink-0 text-sm text-muted-foreground">
              Owner
            </span>
          </div>

          {otherAccepted.map((member) => {
            const name = member.user?.name || member.email;
            const initials = getInitials(name);
            return (
              <div
                key={member._id}
                className="flex items-center gap-3 rounded-md p-2 hover:bg-muted/50"
              >
                <Avatar className="size-9">
                  <AvatarImage
                    src={member.user?.imageUrl || undefined}
                    alt={name}
                  />
                  <AvatarFallback className="text-sm">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-sm font-medium">{name}</p>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {member.email}
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 gap-1 text-sm"
                      disabled={isMemberBusy}
                    >
                      Member
                      <ChevronDown className="size-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => void handleRemoveMember(member)}
                    >
                      Remove access
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}

          {otherAccepted.length === 0 && pendingInvitees.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">
              No one has been invited yet.
            </p>
          ) : null}
        </div>
      </div>

      {pendingInvitees.length > 0 ? (
        <div className="space-y-2">
          <label className="text-sm font-medium">Invited</label>
          <div className="max-h-[220px] space-y-1 overflow-y-auto">
            {pendingInvitees.map((member) => (
              <div
                key={member._id}
                className="flex items-center gap-3 rounded-md p-2 hover:bg-muted/50"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Clock className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{member.email}</p>
                  <p className="text-xs text-muted-foreground">
                    Invitation pending — they can access after signing in
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 gap-1 text-sm"
                      disabled={isMemberBusy}
                    >
                      Pending
                      <ChevronDown className="size-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => void handleRemoveMember(member)}
                    >
                      Cancel invite
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
