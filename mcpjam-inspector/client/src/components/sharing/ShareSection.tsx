import { useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  Clock,
  Globe,
  Link2,
  Lock,
  MoreHorizontal,
  Users,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { copyToClipboard } from "@/lib/clipboard";
import { getInitials } from "@/lib/utils";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import type {
  ShareAccessOption,
  ShareMemberView,
  ShareSectionCopy,
} from "./share-types";

const INVITE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ShareSectionProps<TEnvelope> = {
  envelope: TEnvelope;
  onUpdated?: (next: TEnvelope) => void;
  isAuthenticated: boolean;
  displayName: string;
  displayEmail?: string;
  profilePictureUrl?: string | null;
  selfEmailLower: string;
  members: ShareMemberView[];
  shareUrl: string | null;
  displayLink: string | null;
  currentPreset: string;
  presets: readonly ShareAccessOption[];
  onSetPreset: (preset: string) => Promise<TEnvelope>;
  onInvite: (email: string) => Promise<TEnvelope>;
  onRemoveMember: (member: ShareMemberView) => Promise<TEnvelope>;
  onRotateLink?: () => Promise<TEnvelope>;
  onRevokeAll?: () => Promise<TEnvelope>;
  disabledReason?: string | null;
  /**
   * Render the "Has access" / "Invited" rosters. Off for surfaces that only
   * hand out the link — the compact Share modal — where membership management
   * stays on the settings page rather than being duplicated into a dialog.
   */
  showMembers?: boolean;
  footerSlot?: ReactNode;
  activeNote?: ReactNode;
  copy: ShareSectionCopy;
  testIds: {
    copy: string;
    unrunnable?: string;
    rotate?: string;
    rotateConfirm?: string;
    email?: string;
    linkOutput?: string;
  };
};

export function ShareSection<TEnvelope>({
  onUpdated,
  isAuthenticated,
  displayName,
  displayEmail,
  profilePictureUrl,
  selfEmailLower,
  members,
  shareUrl,
  displayLink,
  currentPreset,
  presets,
  onSetPreset,
  onInvite,
  onRemoveMember,
  onRotateLink,
  onRevokeAll,
  disabledReason,
  showMembers = true,
  footerSlot,
  activeNote,
  copy,
  testIds,
}: ShareSectionProps<TEnvelope>) {
  const [email, setEmail] = useState("");
  const [isInviting, setIsInviting] = useState(false);
  const [isModeBusy, setIsModeBusy] = useState(false);
  const [isMemberBusy, setIsMemberBusy] = useState(false);
  const [isRotateBusy, setIsRotateBusy] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);

  const { acceptedInvitees, pendingInvitees } = useMemo(() => {
    const active = members.filter((m) => !m.revokedAt);
    const accepted = active.filter((m) => Boolean(m.userId));
    const pending = active.filter((m) => !m.userId);
    return { acceptedInvitees: accepted, pendingInvitees: pending };
  }, [members]);

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

  const updateSettings = (next: TEnvelope) => {
    onUpdated?.(next);
  };

  const ceilingNote = presets.find((option) => option.disabled)?.disabledReason;

  const handlePresetChange = async (preset: string) => {
    if (preset === currentPreset) return;
    if (presets.some((option) => option.value === preset && option.disabled)) {
      return;
    }
    setIsModeBusy(true);
    try {
      updateSettings(await onSetPreset(preset));
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
    if (!normalizedEmail || emailValidationError || disabledReason) return;
    setIsInviting(true);
    try {
      updateSettings(await onInvite(normalizedEmail));
      setEmail("");
      toast.success(`Invited ${normalizedEmail}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to invite");
    } finally {
      setIsInviting(false);
    }
  };

  const handleRemoveMember = async (member: ShareMemberView) => {
    setIsMemberBusy(true);
    try {
      updateSettings(await onRemoveMember(member));
      toast.success(`Removed ${member.email}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove member",
      );
    } finally {
      setIsMemberBusy(false);
    }
  };

  const handleCopyLink = async () => {
    if (disabledReason || !shareUrl) return;
    const ok = await copyToClipboard(shareUrl);
    if (ok) toast.success("Link copied");
    else toast.error("Failed to copy share link");
  };

  const handleRotate = async () => {
    if (!onRotateLink) return;
    setIsRotateBusy(true);
    try {
      updateSettings(await onRotateLink());
      toast.success("Share link rotated");
      setRotateOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to rotate link",
      );
    } finally {
      setIsRotateBusy(false);
    }
  };

  const handleRevokeAll = async () => {
    if (!onRevokeAll) return;
    setIsMemberBusy(true);
    try {
      updateSettings(await onRevokeAll());
      toast.success("All share access revoked");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to revoke access",
      );
    } finally {
      setIsMemberBusy(false);
    }
  };

  const currentOption = presets.find((p) => p.value === currentPreset);
  const AccessIcon =
    currentPreset === "project" || currentPreset === "project_members"
      ? Users
      : currentPreset === "link_guests" ||
          currentPreset === "anyone_with_link"
        ? Globe
        : Lock;

  if (!isAuthenticated) {
    return (
      <p className="pt-4 text-sm text-muted-foreground">
        {copy.signedOutMessage ?? "Sign in to manage access."}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={testIds.linkOutput}>
          {copy.linkLabel}
        </label>
        <div className="flex gap-2">
          <output
            id={testIds.linkOutput}
            className="flex min-w-0 flex-1 items-center rounded-md border border-input bg-muted/30 px-3 py-2"
            title={shareUrl ?? undefined}
          >
            <span className="truncate text-sm text-muted-foreground">
              {disabledReason
                ? (copy.withheldLabel ?? "Withheld — this can't be shared.")
                : (displayLink ??
                  (copy.emptyLinkLabel ?? "No share link yet."))}
            </span>
          </output>
          <Button
            type="button"
            variant="outline"
            disabled={!shareUrl || Boolean(disabledReason)}
            onClick={() => void handleCopyLink()}
            data-testid={testIds.copy}
          >
            <Link2 className="mr-1.5 size-4" />
            Copy link
          </Button>
          {onRotateLink || onRevokeAll ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Share link actions"
                  data-testid={testIds.rotate ?? "share-rotate-menu"}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onRotateLink ? (
                  <DropdownMenuItem
                    onClick={() => setRotateOpen(true)}
                    data-testid="share-rotate-link"
                  >
                    {copy.rotateLabel ?? "Rotate link"}
                  </DropdownMenuItem>
                ) : null}
                {onRevokeAll ? (
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => void handleRevokeAll()}
                    data-testid="share-revoke-all"
                  >
                    {copy.revokeAllLabel ?? "Revoke all access"}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {disabledReason ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid={testIds.unrunnable}
          >
            {disabledReason} Point this at a working environment to share it
            again — its link and its sessions are unchanged.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={testIds.email}>
          {copy.inviteLabel ?? "Invite with email"}
        </label>
        <div className="flex gap-2">
          <div className="flex flex-1 items-center rounded-md border border-input focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
            <Input
              id={testIds.email}
              type="email"
              placeholder="Add people, emails..."
              value={email}
              disabled={Boolean(disabledReason)}
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
              !normalizedEmail ||
              !!emailValidationError ||
              isInviting ||
              Boolean(disabledReason)
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
        <label className="text-sm font-medium">
          {copy.accessLabel ?? "Access settings"}
        </label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              disabled={isModeBusy}
            >
              <AccessIcon className="size-4 shrink-0" />
              <span className="flex-1 text-left">
                {currentOption?.label ?? currentPreset}
              </span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-[--radix-dropdown-menu-trigger-width]"
          >
            <DropdownMenuRadioGroup
              value={currentPreset}
              onValueChange={(v) => void handlePresetChange(v)}
            >
              {presets.map((option) => (
                <DropdownMenuRadioItem
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="items-start"
                >
                  <div>
                    <div className="flex items-center gap-2 font-medium">
                      {option.value === "project" ||
                      option.value === "project_members" ? (
                        <Users className="size-4" />
                      ) : option.value === "link_guests" ||
                        option.value === "anyone_with_link" ? (
                        <Globe className="size-4" />
                      ) : (
                        <Lock className="size-4" />
                      )}
                      {option.label}
                    </div>
                    <p className="text-xs font-normal text-muted-foreground">
                      {option.description}
                    </p>
                  </div>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {ceilingNote ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {ceilingNote}
          </p>
        ) : null}
        {activeNote}
      </div>

      {showMembers ? (
      <div className="space-y-2">
        <label className="text-sm font-medium">
          {copy.hasAccessLabel ?? "Has access"}
        </label>
        <div className="max-h-[300px] space-y-1 overflow-y-auto">
          <div className="flex items-center gap-3 rounded-md p-2">
            <Avatar className="size-9">
              <AvatarImage src={profilePictureUrl ?? undefined} alt={displayName} />
              <AvatarFallback className="text-sm">
                {getInitials(displayName)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-medium">{displayName}</p>
                <span className="text-xs text-muted-foreground">(you)</span>
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {displayEmail}
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
                key={member.id}
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
      ) : null}

      {showMembers && pendingInvitees.length > 0 ? (
        <div className="space-y-2">
          <label className="text-sm font-medium">
            {copy.invitedLabel ?? "Invited"}
          </label>
          <div className="max-h-[220px] space-y-1 overflow-y-auto">
            {pendingInvitees.map((member) => (
              <div
                key={member.id}
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

      {footerSlot}

      <AlertDialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {copy.rotateConfirmTitle ?? "Rotate this share link?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {copy.rotateConfirmBody ??
                "Anyone with the old URL will no longer be able to redeem it. People who already opened the link keep their access until you remove them."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRotateBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isRotateBusy}
              onClick={(event) => {
                event.preventDefault();
                void handleRotate();
              }}
              data-testid={testIds.rotateConfirm ?? "share-rotate-confirm"}
            >
              {isRotateBusy ? "Rotating…" : "Rotate link"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
