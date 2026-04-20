import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Clock, Globe, Lock, Users } from "lucide-react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { toast } from "sonner";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import {
  type ChatboxMember,
  type ChatboxSettings,
  useChatboxMutations,
} from "@/hooks/useChatboxes";
import { getInitials } from "@/lib/utils";
import {
  chatboxAccessPresetFromSettings,
  settingsFromChatboxAccessPreset,
  type ChatboxAccessPreset,
} from "@/lib/chatbox-access-presets";
import { Avatar, AvatarFallback, AvatarImage } from "@mcpjam/design-system/avatar";
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
  /** Shown as the workspace-wide access option label (e.g. current workspace name). */
  workspaceName?: string | null;
}

export function ChatboxShareSection({
  chatbox,
  onUpdated,
  workspaceName,
}: ChatboxShareSectionProps) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const { profilePictureUrl } = useProfilePicture();
  const {
    setChatboxMode,
    updateChatbox,
    upsertChatboxMember,
    removeChatboxMember,
  } = useChatboxMutations();

  const [settings, setSettings] = useState<ChatboxSettings>(chatbox);
  const [email, setEmail] = useState("");
  const [isInviting, setIsInviting] = useState(false);
  const [isModeBusy, setIsModeBusy] = useState(false);
  const [isMemberBusy, setIsMemberBusy] = useState(false);

  useEffect(() => {
    setSettings(chatbox);
  }, [chatbox]);

  const workspaceLabel = workspaceName?.trim() || "Workspace";

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
      acceptedInvitees.filter(
        (m) => m.email.toLowerCase() !== selfEmailLower,
      ),
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
      if (target.allowGuestAccess !== next.allowGuestAccess) {
        next = (await updateChatbox({
          chatboxId: settings.chatboxId,
          allowGuestAccess: target.allowGuestAccess,
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
      case "workspace":
        return workspaceLabel;
      case "invited_only":
        return "Invited users only";
      case "link_guests":
        return "Anyone with the link (guests included)";
    }
  };

  const AccessIcon =
    accessPreset === "workspace"
      ? Users
      : accessPreset === "link_guests"
        ? Globe
        : Lock;

  if (!isAuthenticated) {
    return (
      <p className="pt-4 text-sm text-muted-foreground">
        Sign in to manage chatbox access.
      </p>
    );
  }

  return (
    <div className="space-y-6">
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
            disabled={
              !normalizedEmail || !!emailValidationError || isInviting
            }
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
              <DropdownMenuRadioItem value="workspace" className="items-start">
                <div>
                  <div className="flex items-center gap-2 font-medium">
                    <Users className="size-4" />
                    {workspaceLabel}
                  </div>
                  <p className="text-xs font-normal text-muted-foreground">
                    Signed-in members of this workspace can open the chatbox
                    with the link. Guests cannot.
                  </p>
                </div>
              </DropdownMenuRadioItem>
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
                    Only people you invite by email can open this chatbox.
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
                    Anyone with the link can open the chatbox, including guests
                    without an account.
                  </p>
                </div>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
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
                  <AvatarFallback className="text-sm">{initials}</AvatarFallback>
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
