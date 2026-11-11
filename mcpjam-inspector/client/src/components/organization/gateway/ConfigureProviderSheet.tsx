/**
 * A saved custom provider's configure panel, opened from its row. The last
 * Test and the model mapping are always in view; what it works with, where
 * calls come from, its APIs, capability corrections and the base URL and key
 * sit in sections that show their current value when closed.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  CircleDashed,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import type {
  OrgModelProvider,
  UpsertOrgProviderArgs,
} from "@/hooks/use-org-model-config";
import {
  GATEWAY_APIS,
  GATEWAY_API_LABELS,
  gatewayHost,
  type GatewayApi,
} from "@/shared/gateway-connection";
import { hostedModelDefinitionsFromSnapshot } from "@/shared/types";
import { pluralize } from "@/components/chat-v2/shared/chat-helpers";
import { PassedLine } from "./AddProviderDialog";
import {
  GatewayConnectionFields,
  GatewayRuntimeField,
  GatewayTestAlert,
} from "./GatewayFormParts";
import {
  GatewayCapabilityOverrides,
  GatewayModelMapping,
} from "./GatewayModelTable";
import { GatewayApiList, GatewayWorksWithList } from "./GatewayReadiness";
import { testedFromLabel } from "./gateway-test-outcome";
import {
  blockedLabel,
  harnessesOn,
  joinNames,
  providerAttention,
} from "./gateway-works-with";
import { useGatewayDraft, type GatewayDraft } from "./use-gateway-draft";

export type ConfigureSection =
  "works-with" | "calls" | "apis" | "capabilities" | "connection";

const RUNTIME_LABELS = {
  cloud: "MCPJam's servers",
  local: "Each user's Inspector",
};

const apiNames = (apis: readonly GatewayApi[]) =>
  joinNames(apis.map((api) => GATEWAY_API_LABELS[api]));

export function ConfigureProviderSheet({
  provider,
  open,
  onOpenChange,
  organizationId,
  requireOrgKeys,
  isSaving,
  onSave,
  initialSection,
}: {
  provider: OrgModelProvider | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  requireOrgKeys: boolean;
  isSaving: boolean;
  onSave: (args: UpsertOrgProviderArgs) => Promise<void>;
  /** The section a row's badge opens the panel on. */
  initialSection?: ConfigureSection;
}) {
  const catalogIds = useMemo(
    () => hostedModelDefinitionsFromSnapshot().map((model) => String(model.id)),
    [],
  );
  const [sections, setSections] = useState<string[]>([]);
  const draft = useGatewayDraft({
    open,
    onOpenChange,
    organizationId,
    editProvider: provider,
    isSaving,
    // A field the Test blamed sits in "Base URL and key": open it to focus it.
    onFieldProblem: () =>
      setSections((current) =>
        current.includes("connection") ? current : [...current, "connection"],
      ),
  });
  useEffect(() => {
    if (open) setSections(initialSection ? [initialSection] : []);
  }, [open, provider, initialSection]);

  if (!provider) return null;

  const { baseUrl, apis, models, runtime, keyProblem } = draft;
  const name =
    provider.displayName || provider.providerKey.replace(/^custom:/, "");
  const attention = providerAttention({
    apis,
    runtimeLocation: runtime,
    models,
    requireOrgKeys,
  });
  const blocked = blockedLabel(attention.blocked);
  const failed = GATEWAY_APIS.filter((api) => draft.results[api] === "failed");
  const overrides = models
    .flatMap((model) => Object.values(model.capabilities ?? {}))
    .filter((observed) => observed?.source === "declared").length;
  const canSave =
    draft.dirty &&
    !!baseUrl.trim() &&
    !keyProblem &&
    apis.length > 0 &&
    models.length > 0;

  const save = () =>
    void onSave({
      providerKey: provider.providerKey,
      displayName: name,
      ...draft.connection,
    });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 outline-none sm:max-w-2xl"
        // Land on the panel, not on "Test again": reading comes before acting.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        <SheetHeader className="border-b px-6 py-4">
          <div className="flex items-start justify-between gap-4 pr-8">
            <div className="min-w-0 space-y-1">
              <SheetTitle className="text-lg">{name}</SheetTitle>
              <SheetDescription className="truncate">
                {baseUrl || provider.baseUrl}
              </SheetDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void draft.runTest()}
              disabled={!baseUrl.trim() || draft.testing}
            >
              {draft.testing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {draft.testing ? "Testing..." : "Test again"}
            </Button>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <TestStatus provider={provider} draft={draft} />
          <GatewayModelMapping
            models={models}
            catalogIds={catalogIds}
            onChange={draft.setModels}
          />
          <Accordion
            type="multiple"
            value={sections}
            onValueChange={setSections}
            className="border-t"
          >
            <Section
              value="works-with"
              title="Works with"
              summary={blocked ?? "Ready"}
              warn={!!blocked}
            >
              <div className="[&_h3]:sr-only">
                <GatewayWorksWithList rows={attention.rows} />
              </div>
            </Section>
            <Section
              value="calls"
              title="Calls come from"
              summary={RUNTIME_LABELS[runtime]}
            >
              <div className="[&_legend]:sr-only">
                <GatewayRuntimeField
                  value={runtime}
                  onChange={draft.setRuntime}
                />
              </div>
            </Section>
            <Section
              value="apis"
              title="APIs"
              summary={`${pluralize(apis.length, "API")} on${
                failed.length > 0 ? ` · ${apiNames(failed)} didn't answer` : ""
              }`}
              warn={failed.length > 0 || apis.length === 0}
            >
              <div className="space-y-2 [&_legend]:sr-only">
                <GatewayApiList
                  selected={apis}
                  results={draft.results}
                  onChange={draft.setApis}
                />
                {apis.length === 0 ? (
                  <p className="text-sm text-destructive">
                    Choose at least one API the provider serves.
                  </p>
                ) : null}
              </div>
            </Section>
            <Section
              value="capabilities"
              title="Capabilities"
              summary={
                overrides > 0
                  ? pluralize(overrides, "override")
                  : "No overrides"
              }
            >
              <GatewayCapabilityOverrides
                models={models}
                onChange={draft.setModels}
              />
            </Section>
            <Section
              value="connection"
              title="Base URL and key"
              summary={
                keyProblem
                  ? "Enter the API key again"
                  : `${gatewayHost(baseUrl) ?? "No URL"}${
                      provider.hasSecret && !draft.keyRequested
                        ? " · key saved"
                        : ""
                    }`
              }
              warn={!!keyProblem}
            >
              <div className="space-y-4">
                <GatewayConnectionFields
                  draft={draft}
                  hasSecret={provider.hasSecret}
                />
              </div>
            </Section>
          </Accordion>
        </div>

        <SheetFooter className="flex-row justify-end border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave || isSaving}>
            {isSaving ? "Saving..." : "Save changes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** One section: its name, and what it's set to now, while closed. */
function Section({
  value,
  title,
  summary,
  warn = false,
  children,
}: {
  value: ConfigureSection;
  title: string;
  summary: string;
  warn?: boolean;
  children: ReactNode;
}) {
  return (
    <AccordionItem value={value}>
      <AccordionTrigger className="items-center py-3.5 hover:no-underline">
        <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
          <span>{title}</span>
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 font-normal text-muted-foreground",
              warn && "text-foreground",
            )}
          >
            {warn ? (
              <TriangleAlert
                aria-hidden="true"
                className="size-3.5 shrink-0 text-warning"
              />
            ) : null}
            <span className="truncate">{summary}</span>
          </span>
        </span>
      </AccordionTrigger>
      <AccordionContent className="pb-5">{children}</AccordionContent>
    </AccordionItem>
  );
}

/** The Test just run, else the provider's last saved one. */
function TestStatus({
  provider,
  draft,
}: {
  provider: OrgModelProvider;
  draft: GatewayDraft;
}) {
  const { outcome } = draft;
  if (outcome?.tone === "success") {
    return <PassedLine models={draft.models.length} apis={draft.apis.length} />;
  }
  if (outcome) {
    return (
      <GatewayTestAlert
        outcome={outcome}
        onUseInspector={draft.testFromInspector}
      />
    );
  }
  const last = provider.lastTest;
  if (!last) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CircleDashed aria-hidden="true" className="size-4" />
        Not tested since it was saved.
      </p>
    );
  }
  if (last.ok) {
    return (
      <p className="flex items-center gap-2 text-sm">
        <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
        <span className="font-medium">Last test passed.</span>
        <span className="text-muted-foreground">
          {testedFromLabel(last.origin)}.
        </span>
      </p>
    );
  }
  const failed = GATEWAY_APIS.filter((api) => last.apis[api] === "failed");
  const harnesses = failed.flatMap(harnessesOn);
  return (
    <Alert variant="warning">
      <TriangleAlert />
      <AlertTitle>
        {failed.length > 0
          ? `${apiNames(failed)} didn't answer the last test`
          : "The last test failed"}
      </AlertTitle>
      <AlertDescription>
        {last.message ? <p>{last.message}</p> : null}
        {harnesses.length > 0 ? (
          <p>
            Until {failed.length === 1 ? "it answers" : "they answer"},{" "}
            {joinNames(harnesses)} can't use this provider.
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
