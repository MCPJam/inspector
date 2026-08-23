import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import {
  useShareMutations,
  useShareSettings,
  type ShareResourceType,
} from "@/hooks/useShares";
import { ShareSection } from "./ShareSection";
import { applyShareCeilingToOptions } from "@/lib/share-mode-ceiling";
import type {
  ShareAccessOption,
  ShareMode,
  ShareSettingsEnvelope,
} from "./share-types";

const RUN_PRESETS: readonly ShareAccessOption[] = [
  {
    value: "project_members",
    label: "Project members",
    description: "Only signed-in members of this project can open the share.",
  },
  {
    value: "invited_only",
    label: "Invited users only",
    description: "Only people you invite by email can open the share.",
  },
  {
    value: "anyone_with_link",
    label: "Anyone with the link",
    description:
      "Anyone with the link can view a frozen snapshot. Guests are browser sessions, not verified individuals.",
  },
];

export function ResourceSharePanel({
  resourceType,
  resourceId,
  disabledReason,
  footerSlot,
  linkLabel,
  buildShareUrl,
  testIdPrefix,
}: {
  resourceType: ShareResourceType;
  resourceId: string;
  disabledReason?: string | null;
  footerSlot?: ReactNode;
  linkLabel: string;
  buildShareUrl: (token: string) => string;
  testIdPrefix: string;
}) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const { profilePictureUrl } = useProfilePicture();
  const { settings, isLoading } = useShareSettings({
    isAuthenticated,
    resourceType,
    resourceId,
  });
  const {
    setShareMode,
    rotateShareLink,
    upsertShareMember,
    removeShareMember,
    revokeAllShares,
  } = useShareMutations();
  const [envelope, setEnvelope] = useState<ShareSettingsEnvelope | null>(
    settings ?? null,
  );

  useEffect(() => {
    if (settings) setEnvelope(settings);
  }, [settings]);

  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "You";
  const selfEmailLower = user?.email?.toLowerCase() ?? "";
  const shareUrl =
    envelope?.link?.token && !disabledReason
      ? buildShareUrl(envelope.link.token)
      : null;
  const displayLink = shareUrl?.replace(/^https?:\/\//, "") ?? null;
  const currentPreset: ShareMode = envelope?.mode ?? "project_members";
  const members = useMemo(() => envelope?.members ?? [], [envelope?.members]);
  const presets = useMemo(
    () => applyShareCeilingToOptions(RUN_PRESETS, envelope?.maxShareMode),
    [envelope?.maxShareMode],
  );

  if (!envelope) {
    // `getShareSettings` returns null — not undefined — for a resource the
    // caller cannot read or that does not exist. Keying the spinner off
    // "no envelope" left that case loading forever.
    if (isLoading) {
      return (
        <p className="text-sm text-muted-foreground" role="status">
          Loading share settings…
        </p>
      );
    }
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Sharing is unavailable for this item.
      </p>
    );
  }

  return (
    <ShareSection
      envelope={envelope}
      onUpdated={setEnvelope}
      isAuthenticated={isAuthenticated}
      displayName={displayName}
      displayEmail={user?.email}
      profilePictureUrl={profilePictureUrl}
      selfEmailLower={selfEmailLower}
      members={members}
      shareUrl={shareUrl}
      displayLink={displayLink}
      currentPreset={currentPreset}
      presets={presets}
      disabledReason={disabledReason}
      footerSlot={footerSlot}
      copy={{
        linkLabel,
        signedOutMessage: "Sign in to manage sharing.",
        rotateConfirmTitle: "Rotate this share link?",
        rotateConfirmBody:
          "Anyone with the old URL will no longer be able to redeem it. Invited people keep their access.",
        revokeAllLabel: "Revoke all access",
      }}
      testIds={{
        copy: `${testIdPrefix}-copy-link`,
        rotate: `${testIdPrefix}-link-menu`,
        rotateConfirm: `${testIdPrefix}-rotate-confirm`,
        email: `${testIdPrefix}-email`,
        linkOutput: `${testIdPrefix}-link`,
      }}
      onSetPreset={async (preset) =>
        setShareMode({
          resourceType,
          resourceId,
          mode: preset as ShareMode,
        })
      }
      onInvite={async (email) =>
        upsertShareMember({
          resourceType,
          resourceId,
          email,
          sendInviteEmail: true,
        })
      }
      onRemoveMember={async (member) =>
        removeShareMember({
          resourceType,
          resourceId,
          memberIdOrEmail: member.email,
        })
      }
      onRotateLink={async () => rotateShareLink({ resourceType, resourceId })}
      onRevokeAll={async () => revokeAllShares({ resourceType, resourceId })}
    />
  );
}
