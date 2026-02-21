import { useEffect, useMemo, useState } from "react";
import {
  Clock,
  Copy,
  Globe,
  Link2,
  Loader2,
  Lock,
  RotateCw,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useConvexAuth } from "convex/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getInitials } from "@/lib/utils";
import {
  type ServerShareMember,
  type ServerShareMode,
  type ServerShareSettings,
  useServerShareMutations,
  useServerShareSettings,
} from "@/hooks/useServerShares";
import { slugify } from "@/lib/shared-server-session";

interface ShareServerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  serverId: string;
  serverName: string;
}

export function ShareServerDialog({
  isOpen,
  onClose,
  serverId,
  serverName,
}: ShareServerDialogProps) {
  const { isAuthenticated } = useConvexAuth();
  const { settings: queriedSettings } = useServerShareSettings({
    isAuthenticated,
    serverId: isOpen ? serverId : null,
  });
  const {
    ensureServerShare,
    setServerShareMode,
    rotateServerShareLink,
    upsertServerShareMember,
    removeServerShareMember,
  } = useServerShareMutations();

  const [settings, setSettings] = useState<ServerShareSettings | null>(null);
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isMutating, setIsMutating] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setEmail("");
      setIsLoading(false);
      setIsMutating(false);
      return;
    }

    if (queriedSettings) {
      setSettings(queriedSettings);
      return;
    }

    let cancelled = false;
    const run = async () => {
      setIsLoading(true);
      try {
        const ensured = (await ensureServerShare({
          serverId,
        })) as ServerShareSettings;
        if (!cancelled) {
          setSettings(ensured);
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(
            error instanceof Error
              ? error.message
              : "Failed to load server sharing",
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [ensureServerShare, isOpen, queriedSettings, serverId]);

  const activeMembers = useMemo(
    () => settings?.members?.filter((member) => !member.revokedAt) ?? [],
    [settings],
  );

  const handleCopyLink = async () => {
    if (!settings?.link?.token) return;
    try {
      const slug = slugify(serverName);
      const shareUrl = `${window.location.origin}/shared/${slug}/${encodeURIComponent(settings.link.token)}`;
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Share link copied");
    } catch {
      toast.error("Failed to copy link");
    }
  };

  const handleRotate = async () => {
    setIsMutating(true);
    try {
      const next = (await rotateServerShareLink({
        serverId,
      })) as ServerShareSettings;
      setSettings(next);
      toast.success("Share link rotated — previous link is now invalid");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to rotate link",
      );
    } finally {
      setIsMutating(false);
    }
  };

  const handleModeChange = async (mode: ServerShareMode) => {
    if (!settings || settings.mode === mode) return;

    setIsMutating(true);
    try {
      const next = (await setServerShareMode({
        serverId,
        mode,
      })) as ServerShareSettings;
      setSettings(next);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update share mode",
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
      const next = (await upsertServerShareMember({
        serverId,
        email: normalizedEmail,
        sendInviteEmail: true,
      })) as ServerShareSettings;
      setSettings(next);
      setEmail("");
      toast.success(`Invited ${normalizedEmail}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to invite");
    } finally {
      setIsMutating(false);
    }
  };

  const handleRemoveMember = async (member: ServerShareMember) => {
    setIsMutating(true);
    try {
      const next = (await removeServerShareMember({
        serverId,
        memberIdOrEmail: member.email,
      })) as ServerShareSettings;
      setSettings(next);
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
      <DialogContent className="sm:max-w-[480px] gap-0">
        <DialogHeader>
          <DialogTitle>Share &ldquo;{serverName}&rdquo;</DialogTitle>
        </DialogHeader>

        {!isAuthenticated ? (
          <p className="text-sm text-muted-foreground pt-4">
            Sign in to manage shared server access.
          </p>
        ) : isLoading && !settings ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground pt-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading share settings...
          </div>
        ) : !settings ? (
          <p className="text-sm text-muted-foreground pt-4">
            Unable to load sharing settings.
          </p>
        ) : (
          <>
            {/* Email invite input — top, prominent */}
            <div className="flex gap-2 pt-4 pb-5">
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Add people by email"
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
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

            {/* People with access */}
            <div className="space-y-1">
              <p className="text-sm font-medium">People with access</p>
              <div className="max-h-[220px] overflow-y-auto -mx-1">
                {activeMembers.length === 0 ? (
                  <p className="text-sm text-muted-foreground px-1 py-3">
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
                        className="flex items-center gap-3 px-1 py-1.5 rounded-md hover:bg-muted/50"
                      >
                        {isPending ? (
                          <div className="size-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                            <Clock className="size-3.5 text-muted-foreground" />
                          </div>
                        ) : (
                          <Avatar className="size-8 shrink-0">
                            <AvatarImage
                              src={member.user?.imageUrl || undefined}
                              alt={name}
                            />
                            <AvatarFallback className="text-xs">
                              {initials}
                            </AvatarFallback>
                          </Avatar>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">{name}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {member.email}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {isPending && (
                            <span className="text-xs text-muted-foreground">
                              Pending
                            </span>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => void handleRemoveMember(member)}
                            disabled={isMutating}
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

            {/* General access */}
            <div className="space-y-2 pt-3">
              <p className="text-sm font-medium">General access</p>
              <div className="flex items-center gap-3">
                <div
                  className={`size-8 rounded-full flex items-center justify-center shrink-0 ${
                    settings.mode === "any_signed_in_with_link"
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {settings.mode === "any_signed_in_with_link" ? (
                    <Globe className="size-4" />
                  ) : (
                    <Lock className="size-4" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <Select
                    value={settings.mode}
                    onValueChange={(value) =>
                      void handleModeChange(value as ServerShareMode)
                    }
                    disabled={isMutating}
                  >
                    <SelectTrigger className="h-auto border-none shadow-none px-0 py-0 font-medium text-sm w-auto gap-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any_signed_in_with_link">
                        Anyone with the link
                      </SelectItem>
                      <SelectItem value="invited_only">
                        Invited users only
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {settings.mode === "any_signed_in_with_link"
                      ? "Anyone signed in with the link can chat"
                      : "Only invited people can chat"}
                  </p>
                </div>
              </div>
            </div>

            <Separator className="mt-4 mb-3" />

            {/* Footer: Copy link + Done */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => void handleCopyLink()}
                  disabled={isMutating}
                >
                  <Link2 className="size-3.5" />
                  Copy link
                </Button>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground"
                        onClick={() => void handleRotate()}
                        disabled={isMutating}
                      >
                        <RotateCw className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Reset link (invalidates current link)
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
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
