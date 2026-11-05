import { useMutation } from "convex/react";
import { toast } from "sonner";
import {
  CloudUnreachableNotice,
  EVAL_SANDBOX_CLOUD_UNREACHABLE_MESSAGE,
} from "@/components/computer/CloudUnreachableNotice";
import { useEvalComposeCapable } from "@/components/environment-composer/use-eval-compose-capable";
import { useEphemeralCloudAvailable } from "@/hooks/useProjectComputer";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { useSandboxImages } from "@/hooks/useSandboxImages";
import { useSandboxImagesEnabled } from "@/hooks/useSandboxImagesEnabled";
import type { SuiteCapabilitiesState } from "@/hooks/use-suite-capabilities";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import {
  CI_OWNED_REASON_COPY,
  featureDisabledReason,
  PERMISSION_REASON_COPY,
} from "../capability-reasons";
import { evalSuitePinsSandboxImage } from "../helpers";
import { SuiteClientsSettings } from "../suite-clients-settings";
import { SuiteEnvironmentComposerBar } from "../suite-environment-composer-bar";
import { suiteImageSetting } from "../suite-settings-draft";
import { LEGACY_CLIENTS_ROW_LABEL } from "../suite-settings-groups";
import { SuiteSettingsRow } from "../suite-settings-row";
import type { EvalSuite } from "../types";
import type { SuiteSettingsEditor } from "./use-suite-settings-editor";

/** Whether the computer environment row shows (and its images load). */
export function useComputerEnvironmentRowVisible(
  projectId: string | null,
  capabilitiesReady: boolean,
): boolean {
  // Reproducible-evals image picker.
  //
  // The row keeps its ORIGINAL flag gate as an additional condition, so a
  // deployment whose capabilities read fails behaves exactly as it did before.
  // What changes is what happens when capabilities ARE readable and say no: the
  // row renders disabled with the reason instead of disappearing.
  //
  // ONE condition decides both whether the row renders and whether its images
  // are fetched. They used to be written separately — visibility here, the
  // fetch gated on the client flag alone — so a deployment whose capabilities
  // say images ARE available, seen by a client whose flag is off, rendered
  // an ENABLED select whose only option was "None (default image)". A control
  // that offers nothing is the failure this file is being repaired for.
  const sandboxImagesEnabled = useSandboxImagesEnabled();
  const computerEnvironmentRowVisible = capabilitiesReady
    ? Boolean(projectId)
    : sandboxImagesEnabled && Boolean(projectId);
  return computerEnvironmentRowVisible;
}

/**
 * Where the suite runs: its clients and models (saved right away) and the
 * computer image each iteration boots from (part of the settings draft).
 */
export function SuiteRunTargetSettingsFields({
  suite,
  projectId,
  editor,
  capabilities: capabilitiesResult,
  readOnlyConfig,
  configLocked,
}: {
  suite: EvalSuite;
  projectId: string | null;
  editor: SuiteSettingsEditor;
  capabilities: SuiteCapabilitiesState;
  readOnlyConfig: boolean;
  configLocked: boolean;
}) {
  const { draft, dispatchDraft } = editor;
  const { state: capabilitiesState, capabilities } = capabilitiesResult;
  const capabilitiesReady = capabilitiesState === "ready" && capabilities;
  const { capable: composeCapable } = useEvalComposeCapable(projectId);
  const updateSuite = useMutation("testSuites:updateTestSuite" as any);
  const computerEnvironmentRowVisible = useComputerEnvironmentRowVisible(
    projectId,
    Boolean(capabilitiesReady),
  );
  const computerEnvironments = useSandboxImages(
    computerEnvironmentRowVisible ? projectId : null,
  );
  const ephemeralCloudAvailable = useEphemeralCloudAvailable();
  const projectEnvironments = useProjectEnvironments(projectId, {
    includeAdhoc: true,
  });
  const suitePinsSandboxImage = evalSuitePinsSandboxImage(
    suite,
    projectEnvironments ?? undefined,
  );

  // The debounced default-checks committer, the localStorage pass-criteria
  // mirror and the per-suite draft-reset effect all lived here. All three
  // were machinery for saving on every keystroke: a debounce that serialized
  // its own writes so an out-of-order response could not persist stale text,
  // and a local mirror so a value the server had not accepted yet survived a
  // reload. The draft makes them unnecessary — nothing is written until the
  // person says so, and `rebase` handles a suite that moves underneath.

  const handleUpdateHostAttachments = async (
    attachments: Array<{
      namedHostId: string;
      enabledOptionalServerIds: string[];
    }>,
  ) => {
    try {
      await updateSuite({
        suiteId: suite._id,
        hostAttachments: attachments,
      });
      toast.success(
        attachments.length === 0 ? "Clients cleared" : "Clients updated",
      );
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to update clients"));
      console.error("Failed to update host attachments:", error);
      throw error;
    }
  };

  const handleServerAttachmentUpdate = async (serverAttachmentId: string) => {
    // Picker calls this synchronously inside onClick — don't rethrow,
    // or the unawaited promise becomes an unhandled rejection.
    try {
      await updateSuite({
        suiteId: suite._id,
        serverAttachmentId,
      });
      toast.success("Server group updated");
    } catch (error) {
      toast.error(
        getBillingErrorMessage(error, "Failed to update server group"),
      );
    }
  };

  // ── The three rows that used to vanish ─────────────────────────────────
  //
  // Each keeps its ORIGINAL gate as an additional condition, so a deployment
  // whose capabilities read fails behaves exactly as it did before this. What
  // changes is what happens when capabilities ARE readable and say no: the row
  // renders disabled with the reason instead of disappearing.
  //
  // CI OWNERSHIP IS CHECKED FIRST, ahead of every feature flag and every
  // permission. A role change cannot unlock these rows, so "you don't have
  // permission" would send the reader to ask for access they already hold.
  const ciOwnedReason = configLocked
    ? CI_OWNED_REASON_COPY
    : capabilitiesReady && capabilities.ownership?.ciOwned
      ? CI_OWNED_REASON_COPY
      : undefined;
  // `computerEnvironmentRowVisible` is declared beside the images it gates —
  // see the comment there for why the two share one condition.
  const computerEnvironmentDisabledReason =
    ciOwnedReason ??
    (!capabilitiesReady
      ? undefined
      : (featureDisabledReason(
          capabilities.features?.["sandbox-images"] ??
            capabilities.features?.computers,
        ) ??
        (capabilities.permissions?.["suite.configure"] === false
          ? PERMISSION_REASON_COPY
          : undefined))) ??
    (suiteImageSetting(suite).mixed
      ? "These environments pin different images. Change each one's image on the Environments page."
      : undefined);

  return (
    <>
      <SuiteSettingsRow
        settingKey="environments"
        chained={false}
        data-subsection-id="environments"
        label={composeCapable ? undefined : LEGACY_CLIENTS_ROW_LABEL}
        hint="One run per client and model combination. Changes here save right away."
      >
        {projectId ? (
          <SuiteClientsSettings
            suite={suite}
            projectId={projectId}
            readOnly={
              readOnlyConfig ||
              (capabilitiesReady &&
                capabilities.permissions?.["suite.configure"] === false)
            }
          />
        ) : null}
        {/*
                The legacy axes, and the ONLY editor for them.
                `SuiteClientsSettings` needs `modelMatrix`; where the
                deployment does not offer it the matrix renders disabled,
                and a project suite was left with no way to change its
                clients OR its server group at all. The composer decides
                for itself which mode it is in, so it is safe to render
                beside the matrix rather than instead of it: with compose
                capable it shows the environment strip, without it the
                legacy client and server pickers.
              */}
        {projectId && !composeCapable ? (
          <div className="mt-3">
            <SuiteEnvironmentComposerBar
              containerVariant="inline"
              suite={suite}
              onUpdate={handleUpdateHostAttachments}
              onUpdateServerAttachment={handleServerAttachmentUpdate}
              omitComputers
            />
          </div>
        ) : null}
        {projectId ? null : (
          <SuiteEnvironmentComposerBar
            suite={suite}
            onUpdate={handleUpdateHostAttachments}
            onUpdateServerAttachment={handleServerAttachmentUpdate}
            omitComputers
          />
        )}
      </SuiteSettingsRow>

      {computerEnvironmentRowVisible ? (
        <SuiteSettingsRow
          settingKey="computerEnvironment"
          chained={false}
          data-subsection-id="computerEnvironment"
          disabledReason={computerEnvironmentDisabledReason}
          hint="Each iteration boots a fresh MCPJam cloud sandbox from this image, never on this machine. Build the image first, or the run fails fast."
        >
          <select
            className="h-8 max-w-[16rem] rounded-md border border-input bg-background px-2 text-xs text-foreground"
            value={draft.current.computerEnvironmentId ?? ""}
            aria-label="Reproducible computer environment for eval runs"
            onChange={(e) =>
              dispatchDraft({
                type: "edit",
                key: "computerEnvironmentId",
                value: e.target.value || undefined,
              })
            }
          >
            <option value="">None (default image)</option>
            {(computerEnvironments ?? []).map((env) => {
              const ready = env.currentBuild?.status === "ready";
              return (
                <option key={env.environmentId} value={env.environmentId}>
                  {env.name}
                  {ready ? "" : " (not built)"}
                </option>
              );
            })}
          </select>
          {suitePinsSandboxImage && ephemeralCloudAvailable === false ? (
            <div className="mt-2">
              <CloudUnreachableNotice
                data-testid="suite-eval-cloud-unreachable"
                message={EVAL_SANDBOX_CLOUD_UNREACHABLE_MESSAGE}
                detail="Runs started here would fail their computer setup — Run all is disabled until cloud sandboxes are reachable."
              />
            </div>
          ) : null}
        </SuiteSettingsRow>
      ) : null}
    </>
  );
}
