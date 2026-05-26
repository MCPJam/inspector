import { User } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@mcpjam/design-system/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { getInitials } from "@/lib/utils";
import type { ProjectThreadOwnerAvatar } from "@/components/chat-v2/history/project-thread-owner-avatar";

/** Lookup table keyed by Convex userId, matching `buildProjectOwnerProfileByUserId`. */
type ProfileMap = Map<string, { imageUrl: string; name: string }>;

interface BuildSenderAvatarResolverOptions {
  profileByUserId: ProfileMap;
  /**
   * UserId used when a persisted message has no `senderUserId` (legacy rows
   * predating the backend stamp) or when the live message has not yet picked
   * up the actor's id. Typically the session owner or, for fresh in-memory
   * threads, the current user.
   */
  fallbackOwnerUserId?: string | null;
}

/**
 * Build a stable resolver for transcript renderers. Mirrors the discriminated
 * union the rail's `resolveProjectThreadOwnerAvatar` returns so MessageView
 * can reuse the same render shape.
 */
export function buildSenderAvatarResolver({
  profileByUserId,
  fallbackOwnerUserId,
}: BuildSenderAvatarResolverOptions) {
  return (senderUserId?: string): ProjectThreadOwnerAvatar => {
    const hasSender = !!senderUserId && senderUserId.length > 0;
    if (hasSender) {
      // Sender is identified. Render their profile if we can; otherwise
      // attribute to a former-member generic avatar — do NOT silently
      // misattribute to the session owner.
      const direct = profileByUserId.get(senderUserId);
      if (direct) {
        return {
          status: "show",
          displayName: direct.name,
          imageUrl: direct.imageUrl?.trim() || undefined,
        };
      }
      return { status: "generic" };
    }

    // No sender id (legacy message). Visual fallback to the session owner so
    // pre-stamp shared threads don't look broken.
    const fallback =
      fallbackOwnerUserId && fallbackOwnerUserId.length > 0
        ? profileByUserId.get(fallbackOwnerUserId)
        : undefined;
    if (fallback) {
      return {
        status: "show",
        displayName: fallback.name,
        imageUrl: fallback.imageUrl?.trim() || undefined,
      };
    }

    return { status: "generic" };
  };
}

interface SenderAvatarProps {
  avatar: ProjectThreadOwnerAvatar;
  size?: "sm";
}

/**
 * Per-message sender avatar with hover tooltip. Mirrors the rail's
 * `ChatHistoryRow` owner-avatar treatment but slightly larger (`size-5`)
 * since it lives next to a bubble rather than a one-line row.
 */
export function SenderAvatar({ avatar, size: _size = "sm" }: SenderAvatarProps) {
  const tooltip =
    avatar.status === "show" ? avatar.displayName : "Project member";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex size-5 shrink-0 cursor-default items-center justify-center p-0 leading-none"
          data-testid="transcript-sender-avatar"
        >
          <Avatar className="size-5 border border-border/50">
            {avatar.status === "show" ? (
              <>
                <AvatarImage src={avatar.imageUrl} alt={avatar.displayName} />
                <AvatarFallback className="text-[9px] leading-none">
                  {getInitials(avatar.displayName)}
                </AvatarFallback>
              </>
            ) : (
              <AvatarFallback className="bg-muted">
                <User className="size-2.5 text-muted-foreground" aria-hidden />
              </AvatarFallback>
            )}
          </Avatar>
        </div>
      </TooltipTrigger>
      <TooltipContent side="left">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
