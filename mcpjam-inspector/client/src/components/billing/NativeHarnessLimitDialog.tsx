import { useEffect, useRef } from "react";
import { useUpgradeCheckout } from "@/hooks/use-upgrade-checkout";
import { useUpgradeRequestRecipients } from "@/hooks/use-upgrade-request-recipients";
import { useNativeHarnessTrial } from "@/hooks/use-native-harness-trial";
import { track } from "@/lib/analytics";
import { useOptionalSharedAppState } from "@/state/app-state-context";
import {
  useNativeHarnessLimitDialogStore,
  type NativeHarnessLimitNotice,
} from "@/stores/native-harness-limit-dialog-store";
import { NATIVE_HARNESS_TRIAL_TURNS } from "@/shared/native-harness-trial";
import { NativeHarnessLimitDialogView } from "./NativeHarnessLimitDialogView";
import { ScenarioOwnerLimitDialogView } from "./ScenarioOwnerLimitDialogView";

const WALL = {
  location: "plan_limit_dialog",
  wall_kind: "native_harness",
  limit_kind: "native_harness_turns",
  origin: "native_harness",
} as const;

/**
 * The refusal for a native turn once a Free organization has used its trial.
 * Mounted by `MCPJamLimitDialog`, so it shows wherever the refusal landed.
 */
export function NativeHarnessLimitDialog() {
  const notice = useNativeHarnessLimitDialogStore((s) => s.notice);
  const close = useNativeHarnessLimitDialogStore((s) => s.close);
  if (!notice) return null;
  // Decided before any billing read: the person on a User Testing link may
  // not belong to the owner's organization at all.
  if (notice.surface === "scenario") {
    return (
      <ScenarioOwnerLimitDialogView
        description="The owner of this test has used their organization's free native harness turns. Ask them to upgrade to continue."
        onDismiss={close}
      />
    );
  }
  return <NativeHarnessUpgradeDialog notice={notice} onClose={close} />;
}

function NativeHarnessUpgradeDialog({
  notice,
  onClose,
}: {
  notice: NativeHarnessLimitNotice;
  onClose: () => void;
}) {
  const appState = useOptionalSharedAppState();
  const activeProject = appState?.projects[appState.activeProjectId];
  const organizationId =
    notice.organizationId ?? activeProject?.organizationId ?? null;
  const upgrade = useUpgradeCheckout({
    organizationId,
    origin: "native_harness",
    limitKind: "native_harness_turns",
  });
  const { recipients, isLoading: isLoadingRecipients } =
    useUpgradeRequestRecipients(organizationId);
  const trial = useNativeHarnessTrial(organizationId);
  // Nothing renders until billing says who this is: the hook reads as a
  // member until then, which would flash a request at someone who can upgrade.
  // A member's request also waits for the owners, as the credits dialog's
  // does, or it would open with no request to make.
  const isReady =
    !upgrade.isLoadingBilling &&
    (upgrade.canManageBilling || !isLoadingRecipients);
  const audience = upgrade.canManageBilling ? "billing_manager" : "member";

  const shownRef = useRef(false);
  useEffect(() => {
    if (!isReady || shownRef.current) return;
    shownRef.current = true;
    track("plan_limit_dialog_shown", {
      ...WALL,
      organization_id: organizationId,
      audience,
      primary_action: upgrade.canManageBilling
        ? "upgrade"
        : recipients.length > 0
          ? "request_owner"
          : "none",
      request_recipient_count: recipients.length,
      effective_plan: upgrade.effectivePlan,
    });
  }, [
    audience,
    isReady,
    organizationId,
    recipients.length,
    upgrade.canManageBilling,
    upgrade.effectivePlan,
  ]);

  if (!isReady) return null;

  const dismiss = () => {
    onClose();
    track("plan_limit_dialog_dismissed", {
      ...WALL,
      organization_id: organizationId,
      audience,
    });
  };
  const startUpgrade = async () => {
    const result = await upgrade.start();
    if (result.shouldDismiss) onClose();
  };

  return (
    <NativeHarnessLimitDialogView
      granted={notice.granted ?? trial?.granted ?? NATIVE_HARNESS_TRIAL_TURNS}
      canUpgrade={upgrade.canManageBilling}
      requestRecipients={recipients}
      organizationId={organizationId}
      organizationName={upgrade.organizationName}
      teamName={upgrade.teamName}
      isUpgrading={upgrade.isStarting || upgrade.isLoadingPrices}
      onUpgrade={() => void startUpgrade()}
      onDismiss={dismiss}
    />
  );
}
