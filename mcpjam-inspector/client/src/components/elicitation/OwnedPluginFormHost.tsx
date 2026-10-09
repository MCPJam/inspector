import { PluginFormPreviewServices } from "./form-app-preview";
import { formResourcePreviewPorts } from "./form-resource-preview";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { decodePrivatePluginFormSchema } from "@/shared/plugin-extensions/form-plan";
import type { ReactNode } from "react";
import {
  useComposerFormRegistration,
  useComposerFormStore,
  useComposerSlot,
} from "./composer-form-store";
import {
  ComposerFormCard,
  ComposerFormFrame,
  type ComposerFormAction,
} from "./ComposerFormCard";
import {
  compileComposerForm,
  logComposerFormDiagnostics,
} from "./form-diagnostics";
import type { PluginFormPorts } from "../schema-form/PluginFormFields";
import { useServerIconSources } from "../host-workspace/plugin-icon-directory";
import type { PluginFormProfile } from "@/shared/plugin-extensions/form-plan";

export type OwnedPluginFormServices = {
  profile: PluginFormProfile;
  ports?: PluginFormPorts;
  presentation?: ReactNode;
};
export type OwnedPluginFormPresenter = (
  request: HostedElicitationRequestEvent,
  render: (services: OwnedPluginFormServices) => ReactNode,
) => ReactNode;
import { useConvex, useConvexAuth, useQuery } from "convex/react";
import type { HostedElicitationRequestEvent } from "@/shared/hosted-elicitation";
import { createPrivateFormAnswer } from "@/lib/apis/private-form-answer";
import { respondToChatElicitation } from "@/lib/apis/elicitation-api";
import {
  appendPluginDiagnostics,
  describePluginError,
} from "@/lib/plugin-diagnostics";
import { pluginDiagnostic } from "@/shared/plugin-diagnostics";
import {
  PluginDescribedError,
  withPluginDeadline,
} from "@/shared/plugin-operation";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import type { HostedElicitationAnswer } from "@/shared/hosted-elicitation";
import { ElicitationRequestDialog } from "./ElicitationRequestDialog";

/** Hosts kept for chats that are not shown but still have pending forms. */
const MAX_RETAINED_FORM_CHATS = 8;

/** How long sending a form answer may take before the form says so and
 * takes the same answer again. */
export const PLUGIN_FORM_SUBMIT_TIMEOUT_MS = 30_000;

/**
 * One owned form host per chat with pending forms, plus the shown chat's.
 * A chat's forms stay with it: leaving a chat keeps its host mounted but
 * silent, so its pending requests stay registered (closing or archiving that
 * chat still cancels them) and come back, with their answers, on return.
 */
export function ChatPluginFormHosts({
  current,
  exclude = [],
  presentServices,
}: {
  current: { projectId: string; workspaceId: string } | null;
  /** Workspaces another host already serves (the global owner's). */
  exclude?: readonly string[];
  presentServices?: OwnedPluginFormPresenter;
}) {
  const projects = useRef(new Map<string, string>());
  if (current) projects.current.set(current.workspaceId, current.projectId);
  const pendingKey = useComposerFormStore((state) =>
    JSON.stringify([
      ...new Set(
        [...state.forms]
          .sort((a, b) => a.order - b.order)
          .map((form) => form.workspaceId),
      ),
    ]),
  );
  const retained = (JSON.parse(pendingKey) as string[])
    .filter(
      (workspaceId) =>
        workspaceId !== current?.workspaceId &&
        !exclude.includes(workspaceId) &&
        projects.current.has(workspaceId),
    )
    .slice(-MAX_RETAINED_FORM_CHATS);
  const hosts = [
    ...(current ? [current.workspaceId] : []),
    ...retained,
  ];
  return (
    <>
      {hosts.map((workspaceId) => (
        <OwnedPluginFormHost
          key={workspaceId}
          projectId={projects.current.get(workspaceId)!}
          workspaceId={workspaceId}
          active={workspaceId === current?.workspaceId}
          presentServices={presentServices}
        />
      ))}
    </>
  );
}

/** Reactive actor-owned delivery for an extension operation outside the chat stream. */
export function OwnedPluginFormHost({
  projectId,
  workspaceId,
  active = true,
  presentServices,
}: {
  projectId: string;
  workspaceId: string;
  /**
   * False while another chat is shown: requests stay registered (and
   * cancellable) but nothing renders, neither the card nor the modal.
   */
  active?: boolean;
  presentServices?: OwnedPluginFormPresenter;
}) {
  const { isAuthenticated } = useConvexAuth();
  const owner = useQuery(
    "users:getCurrentUser" as any,
    isAuthenticated ? {} : "skip",
  ) as { _id: string } | null | undefined;
  const rows = useQuery(
    "elicitations:listPendingElicitations" as any,
    owner ? { projectId, pluginWorkspaceId: workspaceId } : "skip",
  ) as Omit<HostedElicitationRequestEvent, "kind">[] | undefined;
  const requests =
    rows?.filter(
      (row) =>
        row.formDialect === "openai" &&
        row.pluginWorkspaceId === workspaceId &&
        row.mode === "form",
    ) ?? [];
  if (!owner || !requests.length) return null;
  // Every pending request registers with its chat's composer; only the first
  // in arrival order is shown, the rest wait their turn.
  return (
    <>
      {requests.map((request) => (
        <OwnedRequest
          key={JSON.stringify([
            owner._id,
            projectId,
            workspaceId,
            request.rendezvousId,
          ])}
          projectId={projectId}
          workspaceId={workspaceId}
          active={active}
          presentServices={presentServices}
          request={{ ...request, kind: "request" }}
        />
      ))}
    </>
  );
}

function OwnedRequest({
  request,
  projectId,
  workspaceId,
  active,
  presentServices,
}: {
  presentServices?: OwnedPluginFormPresenter;
  request: HostedElicitationRequestEvent;
  projectId: string;
  workspaceId: string;
  active: boolean;
}) {
  const convex = useConvex();
  const [resolved, setResolved] = useState(false);
  const [schema, setSchema] = useState<unknown>(request.requestedSchema);
  const [schemaFailed, setSchemaFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const convexRef = useRef(convex);
  convexRef.current = convex;
  useEffect(() => {
    if (!request.hasPrivateSchema) return;
    let active = true;
    setSchema(undefined);
    setSchemaFailed(false);
    void convexRef.current
      .action("pluginFormSchemas:read" as any, {
        rendezvousId: request.rendezvousId,
        projectId,
        pluginWorkspaceId: request.pluginWorkspaceId,
        serialized: true,
      })
      .then((value: unknown) => {
        const decoded = decodePrivatePluginFormSchema(value);
        if (active && Date.now() < request.expiresAt) setSchema(decoded);
      })
      .catch(() => {
        if (active) setSchemaFailed(true);
      });
    return () => {
      active = false;
    };
  }, [
    request.hasPrivateSchema,
    request.rendezvousId,
    request.pluginWorkspaceId,
    request.expiresAt,
    projectId,
    attempt,
  ]);
  const answerRef = useRef<
    ReturnType<typeof createPrivateFormAnswer> | undefined
  >(undefined);
  useEffect(() => {
    const privateAnswer = createPrivateFormAnswer({
      kind: "legacy",
      id: request.rendezvousId,
      round: 0,
    });
    answerRef.current = privateAnswer;
    const timer = setTimeout(() => {
      privateAnswer.dispose();
      answerRef.current = undefined;
      setResolved(true);
    }, Math.max(0, request.expiresAt - Date.now()));
    return () => {
      clearTimeout(timer);
      privateAnswer.dispose();
      if (answerRef.current === privateAnswer) answerRef.current = undefined;
    };
  }, [request.rendezvousId, request.expiresAt]);
  const respond = async (answer: HostedElicitationAnswer) => {
    const privateAnswer = answerRef.current;
    if (!privateAnswer) throw new Error("The form request is no longer active");
    let result: Awaited<ReturnType<typeof respondToChatElicitation>>;
    try {
      // Never an endless "sending": the wait is bounded, the card keeps its
      // answers, and a retry sends the same receipt (a repeat of an answer
      // that did land comes back not_pending).
      result = await withPluginDeadline(
        new AbortController().signal,
        PLUGIN_FORM_SUBMIT_TIMEOUT_MS,
        () =>
          new PluginDescribedError(
            describePluginError("PLUGIN_FORM_SUBMIT_TIMEOUT")!,
            "PLUGIN_FORM_SUBMIT_TIMEOUT",
          ),
        async (bounded) => {
          const receipt =
            answer.action === "accept"
              ? await privateAnswer.prepare(answer.content ?? {}, bounded)
              : undefined;
          return respondToChatElicitation(convex, answer, receipt);
        },
      );
    } catch (error) {
      // A request withdrawn underneath its own send isn't a failed send.
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
      const code =
        error instanceof PluginDescribedError
          ? error.code
          : "PLUGIN_FORM_SUBMIT_FAILED";
      appendPluginDiagnostics(
        [
          pluginDiagnostic(
            "error",
            code,
            `Form answer not sent: ${request.message}`.slice(0, 160),
            describePluginError(code) ?? code,
            { action: answer.action },
          ),
        ],
        { serverId: request.serverId, serverName },
      );
      throw error;
    }
    if (!result.ok && !["not_pending", "expired"].includes(result.reason))
      throw new Error("The form answer could not be accepted. Please retry.");
    privateAnswer.dispose();
    if (answerRef.current === privateAnswer) {
      answerRef.current = undefined;
      setResolved(true);
    }
  };
  const serverName = request.serverName?.trim() || request.serverId;
  const icons = useServerIconSources(request.serverId);
  const queue = useComposerFormRegistration(
    resolved
      ? null
      : {
          id: request.rendezvousId,
          workspaceId,
          serverName,
          cancel: () => cancel(),
        },
  );
  const slot = useComposerSlot(workspaceId);
  if (resolved) return null;
  // Later requests for this chat wait until the earlier ones are answered.
  if (!queue.active) return null;
  // Another chat is shown: this request waits with its own chat.
  if (!active) return null;
  // The composer card replaces the modal whenever this chat's composer is
  // mounted; the modal remains for layouts without a composer.
  if (slot) {
    if (request.hasPrivateSchema && schema === undefined)
      return createPortal(
        <ComposerFormFrame
          requestId={request.rendezvousId}
          title={request.message}
          serverName={serverName}
          icons={icons}
          onClose={() => void cancel()}
          closeDisabled={cancelling}
          footer={
            schemaFailed ? (
              <>
                <span className="flex-1" />
                <Button
                  type="button"
                  size="sm"
                  className="h-7"
                  disabled={cancelling}
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Retry
                </Button>
              </>
            ) : undefined
          }
        >
          <p role="status" className="text-muted-foreground">
            {schemaFailed
              ? "The form couldn't be loaded. Retry or close this request."
              : "Loading the form…"}
          </p>
        </ComposerFormFrame>,
        slot,
      );
  }
  // Never mount the editor with a missing private schema. A late read cannot
  // revive an expired, replaced or unmounted request.
  if (request.hasPrivateSchema && schema === undefined)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !cancelling) void cancel();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {schemaFailed ? "Form unavailable" : "Loading form"}
            </DialogTitle>
            <DialogDescription>
              {request.serverName ?? request.serverId}:{" "}
              {schemaFailed
                ? "The form could not be loaded. Retry or cancel this request."
                : "Loading the requested fields."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            {schemaFailed && (
              <Button
                disabled={cancelling}
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </Button>
            )}
            <Button disabled={cancelling} onClick={() => void cancel()}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  async function cancel() {
    setCancelling(true);
    try {
      await respond({ rendezvousId: request.rendezvousId, action: "cancel" });
    } catch {
      setSchemaFailed(true);
    } finally {
      setCancelling(false);
    }
  }
  const hydratedRequest = {
    ...request,
    requestedSchema: schema,
    hasPrivateSchema: undefined,
  };
  const render = (services: OwnedPluginFormServices) =>
    slot ? (
      createPortal(
        <OwnedComposerCard
          request={hydratedRequest}
          services={services}
          onRespond={(action, content) =>
            respond({
              rendezvousId: request.rendezvousId,
              action,
              ...(action === "accept" && content ? { content } : {}),
            })
          }
        />,
        slot,
      )
    ) : (
      <ElicitationRequestDialog
        request={hydratedRequest}
        pluginForm={services}
        onRespond={respond}
      />
    );
  // A missing service never becomes a partial form: the common compiler refuses
  // the entire schema when a required resource or preview port is unavailable.
  if (presentServices) return presentServices(hydratedRequest, render);
  if (request.pluginFormSourceToken)
    return (
      <PluginFormPreviewServices
        scope={{ projectId, workspaceId: request.pluginWorkspaceId! }}
        server={{ serverId: request.serverId, serverName }}
        sourceToken={request.pluginFormSourceToken}
        parent={{ kind: "legacy", id: request.rendezvousId, round: 0 }}
        expiresAt={request.expiresAt}
        schema={schema}
        onCancel={() =>
          respond({ rendezvousId: request.rendezvousId, action: "cancel" })
        }
      >
        {({
          ports,
          presentation,
          userResources,
          userResourceKinds,
          origin,
          fileResources,
        }) =>
          render({
            // A form asked for through an MCP App takes uploads only while
            // the client's File resources toggle is on; the file service
            // says which this is, the same rule the server applies.
            profile: {
              origin: origin ?? "server",
              ...(fileResources !== undefined ? { fileResources } : {}),
              userResources,
              userResourceKinds,
              previews: true,
              previewKinds: ["resource_link", "mcp_app_tool"],
            },
            ports,
            presentation,
          })
        }
      </PluginFormPreviewServices>
    );
  return render({
    profile: {
      origin: "server",
      userResources: false,
      previews: false,
    },
    ports: formResourcePreviewPorts(
      { projectId, workspaceId: request.pluginWorkspaceId! },
      undefined,
      { kind: "legacy", id: request.rendezvousId, round: 0 },
      request.expiresAt,
    ),
  });
}

/** Compile once per request and report refusals and author hints to Logs. */
function OwnedComposerCard({
  request,
  services,
  onRespond,
}: {
  request: HostedElicitationRequestEvent;
  services: OwnedPluginFormServices;
  onRespond: (
    action: ComposerFormAction,
    content?: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const profileKey = JSON.stringify([
    services.profile,
    !!services.ports?.chooseResources,
    !!services.ports?.preview,
  ]);
  const compiled = useMemo(
    () =>
      compileComposerForm(request.requestedSchema, {
        ...services.profile,
        userResources:
          services.profile.userResources && !!services.ports?.chooseResources,
        previews: services.profile.previews && !!services.ports?.preview,
      }),
    // A request is immutable; a different request remounts this card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [request.rendezvousId, profileKey],
  );
  const serverName = request.serverName?.trim() || request.serverId;
  const icons = useServerIconSources(request.serverId);
  useEffect(() => {
    logComposerFormDiagnostics(compiled, {
      serverId: request.serverId,
      serverName,
    });
  }, [compiled, request.serverId, serverName]);
  return (
    <ComposerFormCard
      key={request.rendezvousId}
      requestId={request.rendezvousId}
      title={request.message}
      serverName={serverName}
      icons={icons}
      plan={compiled.plan}
      unsupported={compiled.unsupported}
      ports={services.ports}
      presentation={services.presentation}
      onRespond={onRespond}
    />
  );
}
