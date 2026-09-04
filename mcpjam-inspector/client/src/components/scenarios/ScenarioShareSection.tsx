import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import {
  type ScenarioMember,
  type ScenarioSettings,
  useScenarioMutations,
} from "@/hooks/useScenarios";
import { buildScenarioLink } from "@/lib/scenario-session";
import {
  applyShareCeilingToScenarioOptions,
  scenarioAccessPresetFromSettings,
  settingsFromScenarioAccessPreset,
  type ScenarioAccessPreset,
} from "@/lib/scenario-access-presets";
import { ShareSection } from "@/components/sharing/ShareSection";
import type { ShareMemberView } from "@/components/sharing/share-types";

interface ScenarioShareSectionProps {
  scenario: ScenarioSettings;
  onUpdated?: (scenario: ScenarioSettings) => void;
  /** Shown as the project-wide access option label (e.g. current project name). */
  projectName?: string | null;
  /** Off in the Share modal — roster management stays on the settings page. */
  showMembers?: boolean;
  /**
   * Off in the Share modal. Rotating invalidates every URL already handed
   * out; it belongs behind the settings page, not one click from a button
   * whose whole job is handing the URL out.
   */
  allowRotate?: boolean;
}

function memberView(member: ScenarioMember): ShareMemberView {
  return {
    id: member._id,
    email: member.email,
    userId: member.userId,
    revokedAt: member.revokedAt,
    acceptedAt: member.acceptedAt,
    role: member.role,
    user: member.user,
  };
}

export function ScenarioShareSection({
  scenario,
  onUpdated,
  projectName,
  showMembers = true,
  allowRotate = true,
}: ScenarioShareSectionProps) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const { profilePictureUrl } = useProfilePicture();
  const {
    setScenarioMode,
    upsertScenarioMember,
    removeScenarioMember,
    rotateScenarioLink,
  } = useScenarioMutations();

  const [settings, setSettings] = useState<ScenarioSettings>(scenario);

  useEffect(() => {
    setSettings(scenario);
  }, [scenario]);

  const projectLabel = projectName?.trim() || "Project";
  const accessPreset = scenarioAccessPresetFromSettings(
    settings.mode,
    settings.allowGuestAccess,
  );

  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "You";
  const selfEmailLower = user?.email?.toLowerCase() ?? "";

  const unrunnableReason = settings.environmentError?.message ?? null;
  const shareLink =
    settings.link?.token && !unrunnableReason
      ? buildScenarioLink(settings.link.token, settings.name)
      : null;
  const displayLink = shareLink?.replace(/^https?:\/\//, "") ?? null;

  const members = useMemo(
    () => settings.members.map(memberView),
    [settings.members],
  );

  const presets = useMemo(
    () =>
      applyShareCeilingToScenarioOptions(
        [
          {
            value: "invited_only",
            label: "Invited users only",
            description:
              "Only people you invite by email can open this scenario.",
          },
          {
            value: "link_guests",
            label: "Anyone with the link (guests included)",
            description:
              "Anyone with the link can open the scenario, including guests without an account.",
          },
          {
            value: "project",
            label: projectLabel,
            description:
              "Signed-in members of this project can open the scenario with the link. Guests cannot.",
          },
        ],
        settings.maxShareMode,
      ),
    [projectLabel, settings.maxShareMode],
  );

  const updateSettings = (next: ScenarioSettings) => {
    setSettings(next);
    onUpdated?.(next);
  };

  return (
    <ShareSection
      envelope={settings}
      onUpdated={updateSettings}
      isAuthenticated={isAuthenticated}
      displayName={displayName}
      displayEmail={user?.email}
      profilePictureUrl={profilePictureUrl}
      selfEmailLower={selfEmailLower}
      members={members}
      shareUrl={shareLink}
      displayLink={displayLink}
      currentPreset={accessPreset}
      presets={presets}
      disabledReason={unrunnableReason}
      showMembers={showMembers}
      activeNote={
        accessPreset === "link_guests" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Guest usage runs on your organization&apos;s credits. Guests are
            people who open the link without being invited.
          </p>
        ) : null
      }
      copy={{
        linkLabel: "Tester link",
        signedOutMessage: "Sign in to manage scenario access.",
        withheldLabel: "Withheld — this scenario can't run.",
        rotateConfirmTitle: "Rotate this tester link?",
        rotateConfirmBody:
          "Anyone with the old URL will no longer be able to redeem it. Testers who already opened the link keep their access until you remove them.",
      }}
      testIds={{
        copy: "scenario-copy-tester-link",
        unrunnable: "scenario-share-unrunnable",
        rotate: "scenario-share-link-menu",
        rotateConfirm: "scenario-rotate-confirm",
        email: "scenario-share-email",
        linkOutput: "scenario-tester-link",
      }}
      onSetPreset={async (preset) => {
        const target = settingsFromScenarioAccessPreset(
          preset as ScenarioAccessPreset,
        );
        if (target.mode === settings.mode) return settings;
        return (await setScenarioMode({
          scenarioId: settings.scenarioId,
          mode: target.mode,
        })) as ScenarioSettings;
      }}
      onInvite={async (email) =>
        (await upsertScenarioMember({
          scenarioId: settings.scenarioId,
          email,
          sendInviteEmail: true,
        })) as ScenarioSettings
      }
      onRemoveMember={async (member) =>
        (await removeScenarioMember({
          scenarioId: settings.scenarioId,
          memberIdOrEmail: member.email,
        })) as ScenarioSettings
      }
      onRotateLink={
        allowRotate
          ? async () =>
              (await rotateScenarioLink({
                scenarioId: settings.scenarioId,
              })) as ScenarioSettings
          : undefined
      }
    />
  );
}
