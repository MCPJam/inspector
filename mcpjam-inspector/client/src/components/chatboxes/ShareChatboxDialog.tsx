import { useEffect, useMemo, useState } from "react";
import { Copy, Globe, Link2, Loader2, Lock, RotateCw, X } from "lucide-react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { toast } from "sonner";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import {
  type ChatboxMember,
  type ChatboxMode,
  type ChatboxSettings,
  useChatboxMutations,
} from "@/hooks/useChatboxes";
import { getInitials } from "@/lib/utils";
import { buildChatboxLink } from "@/lib/chatbox-session";
import { Avatar, AvatarFallback, AvatarImage } from "@mcpjam/design-system/avatar";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { Separator } from "@mcpjam/design-system/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";

interface ShareChatboxDialogProps {
  isOpen: boolean;
  onClose: () => void;
  chatbox: ChatboxSettings;
  onUpdated?: (chatbox: ChatboxSettings) => void;
}

export function ShareChatboxDialog({
  isOpen,
  onClose,
  chatbox,
  onUpdated,
}: ShareChatboxDialogProps) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const { profilePictureUrl } = useProfilePicture();
  const {
    setChatboxMode,
    rotateChatboxLink,
    upsertChatboxMember,
    removeChatboxMember,
  } = useChatboxMutations();

  const [settings, setSettings] = useState<ChatboxSettings>(chatbox);
  const [email, setEmail] = useState("");
  const [isMutating, setIsMutating] = useState(false);

  useEffect(() => {
    setSettings(chatbox);
  }, [chatbox]);

  useEffect(() => {
    if (!isOpen) {
      setEmail("");
      setIsMutating(false);
    }
  }, [isOpen]);

  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "You";
  const displayInitials = getInitials(displayName);
  const activeMembers = useMemo(
    () => settings.members.filter((member) => !member.revokedAt),
    [settings.members],
  );

  const updateSettings = (next: ChatboxSettings) => {
    setSettings(next);
    onUpdated?.(next);
  };

  const handleCopyLink = async () => {
    const token = settings.link?.token?.trim();
    if (!token) {
      toast.error("Chatbox link unavailable");
      return;
    }

    try {
      await navigator.clipboard.writeText(
        buildChatboxLink(token, settings.name),
      );
      toast.success("Chatbox link copied");
    } catch {
      toast.error("Failed to copy link");
    }
  };

  const handleRotate = async () => {
    setIsMutating(true);
    try {
      const next = (await rotateChatboxLink({
        chatboxId: settings.chatboxId,
      })) as ChatboxSettings;
      updateSettings(next);
      toast.success("Chatbox link rotated");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to rotate chatbox link",
      );
    } finally {
      setIsMutating(false);
    }
  };

  const handleModeChange = async (mode: ChatboxMode) => {
    if (mode === settings.mode) return;

    setIsMutating(true);
    try {
      const next = (await setChatboxMode({
        chatboxId: settings.chatboxId,
        mode,
      })) as ChatboxSettings;
      updateSettings(next);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update chatbox mode",
      );
    } finally {
      setIsMutating(false);
    }
  };

  const handleInvite = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return;

    setIsMutating(true);
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
      setIsMutating(false);
    }
  };

  const handleRemoveMember = async (member: ChatboxMember) => {
    setIsMutating(true);
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
      setIsMutating(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[520px] gap-0">
        <DialogHeader>
          <DialogTitle>Share &ldquo;{settings.name}&rdquo;</DialogTitle>
        </DialogHeader>

        {!isAuthenticated ? (
          <p className="pt-4 text-sm text-muted-foreground">
            Sign in to manage chatbox access.
          </p>
        ) : (
          <>
            <div className="flex gap-2 pt-4 pb-5">
              <Input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="Add people by email"
                className="flex-1"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleInvite();
                  }
                }}
              />
              <Button
                onClick={() => void handleInvite()}
                disabled={!email.trim() || isMutating}
              >
                {isMutating && email.trim() ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Invite"
                )}
              </Button>
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium">People with access</p>
              <div className="max-h-[220px] overflow-y-auto -mx-1">
                <div className="flex items-center gap-3 rounded-md px-1 py-1.5">
                  <Avatar className="size-8 shrink-0">
                    <AvatarImage src={profilePictureUrl} alt={displayName} />
                    <AvatarFallback className="text-xs">
                      {displayInitials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-sm">{displayName}</p>
                      <span className="text-xs text-muted-foreground">
                        (you)
                      </span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {user?.email}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    Owner
                  </span>
                </div>

                {activeMembers.length === 0 ? (
                  <p className="px-1 py-3 text-sm text-muted-foreground">
                    No one has been invited yet.
                  </p>
                ) : (
                  activeMembers.map((member) => {
                    const name = member.user?.name || member.email;
                    const isPending = !member.userId;
                    const initials = getInitials(name);

                    return (
                      <div
                        key={member._id}
                        className="group flex items-center gap-3 rounded-md px-1 py-1.5 hover:bg-muted/40"
                      >
                        <Avatar className="size-8 shrink-0">
                          <AvatarImage src={member.user?.imageUrl} alt={name} />
                          <AvatarFallback className="text-xs">
                            {initials}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {member.email}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {isPending ? (
                            <span className="text-xs text-muted-foreground">
                              Pending
                            </span>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 opacity-0 group-hover:opacity-100"
                            onClick={() => void handleRemoveMember(member)}
                          >
                            <X className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <Separator className="my-5" />

            <div className="space-y-4">
              <div className="grid gap-2">
                <p className="text-sm font-medium">Access mode</p>
                <Select
                  value={settings.mode}
                  onValueChange={(value) =>
                    void handleModeChange(value as ChatboxMode)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="invited_only">
                      <div className="flex items-center gap-2">
                        <Lock className="size-3.5" />
                        Invite only
                      </div>
                    </SelectItem>
                    <SelectItem value="any_signed_in_with_link">
                      <div className="flex items-center gap-2">
                        <Globe className="size-3.5" />
                        Any signed-in user with the link
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Guest access</p>
                    <p className="text-xs text-muted-foreground">
                      {settings.allowGuestAccess
                        ? "Guests can open this chatbox when the link mode allows it."
                        : "Guests cannot open this chatbox. Signed-in access only."}
                    </p>
                  </div>
                  {settings.allowGuestAccess ? (
                    <Globe className="size-4 text-muted-foreground" />
                  ) : (
                    <Lock className="size-4 text-muted-foreground" />
                  )}
                </div>
              </div>

              <div className="rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Link2 className="size-4" />
                  Share link
                </div>
                <p className="mt-1 text-xs text-muted-foreground break-all">
                  {settings.link?.url || buildChatboxLink("", settings.name)}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleCopyLink()}
                  >
                    <Copy className="mr-1.5 size-3.5" />
                    Copy link
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRotate()}
                    disabled={isMutating}
                  >
                    {isMutating ? (
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    ) : (
                      <RotateCw className="mr-1.5 size-3.5" />
                    )}
                    Rotate
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-5">
              <Button size="sm" onClick={onClose}>
                Done
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
