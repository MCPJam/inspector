import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import type {
  OrgModelProvider,
  UpsertOrgProviderArgs,
} from "@/hooks/use-org-model-config";
import {
  GATEWAY_APIS,
  type GatewayApi,
  type GatewayApiTestResult,
  type GatewayModel,
} from "@/shared/gateway-connection";
import { hostedModelDefinitionsFromSnapshot } from "@/shared/types";
import { useSettingsDraft } from "../../settings/SettingsDraftProvider";
import { ProviderKeyField } from "../ProviderKeyField";
import { GatewayModelTable } from "./GatewayModelTable";
import { GatewayRuntimeField, GatewayTestAlert } from "./GatewayFormParts";
import { GatewayApiList, GatewayWorksWithList } from "./GatewayReadiness";
import {
  apisFromTest,
  baseUrlKeyProblem,
  gatewayTestOutcome,
  inspectorTestKeyOutcome,
  modelsFromTest,
  suggestedGatewayName,
  type GatewayField,
  type GatewayTestOutcome,
} from "./gateway-test-outcome";
import {
  gatewayWorksWith,
  type GatewayRuntimeLocation,
} from "./gateway-works-with";
import { useGatewayConnectionTest } from "./use-gateway-connection-test";

const FIELD_IDS: Record<GatewayField, string> = {
  baseUrl: "gateway-base-url",
  secret: "gateway-secret",
};

/** The slug a new connection is saved under. */
const providerKeyFor = (name: string) =>
  `custom:${name.trim().toLowerCase().replace(/\s+/g, "-")}`;

/**
 * Add or edit a gateway connection: the base URL and key, a Test that fills in
 * the rest (name, APIs, models and their mappings), where calls come from,
 * and what the connection will work with, before it is saved.
 */
export function GatewayDialog({
  open,
  onOpenChange,
  organizationId,
  editProvider,
  existingProviderKeys,
  requireOrgKeys,
  isSaving,
  onSave,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  editProvider: OrgModelProvider | null;
  existingProviderKeys: readonly string[];
  requireOrgKeys: boolean;
  isSaving: boolean;
  onSave: (args: UpsertOrgProviderArgs) => Promise<void>;
  onCancel: () => void;
}) {
  const testConnection = useGatewayConnectionTest(organizationId);
  const catalogIds = useMemo(
    () => hostedModelDefinitionsFromSnapshot().map((model) => String(model.id)),
    [],
  );
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [runtime, setRuntime] = useState<GatewayRuntimeLocation>("cloud");
  const [apis, setApis] = useState<GatewayApi[]>([]);
  const [models, setModels] = useState<GatewayModel[]>([]);
  const [results, setResults] = useState<
    Partial<Record<GatewayApi, GatewayApiTestResult>>
  >({});
  const [outcome, setOutcome] = useState<GatewayTestOutcome | null>(null);
  const [testing, setTesting] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [keyRequested, setKeyRequested] = useState(false);
  const [dirty, setDirty] = useState(false);
  const focusRequest = useRef<GatewayField | null>(null);
  // The latest Test run; a reset or a newer run makes an earlier answer stale.
  const testRun = useRef(0);

  useEffect(() => {
    if (!open) return;
    testRun.current += 1;
    setTesting(false);
    setBaseUrl(editProvider?.baseUrl ?? "");
    setSecret("");
    setName(
      editProvider?.displayName ||
        editProvider?.providerKey.replace(/^custom:/, "") ||
        "",
    );
    setRuntime(editProvider?.runtimeLocation ?? "cloud");
    setApis(editProvider?.apis ?? []);
    setModels(
      editProvider?.models ??
        (editProvider?.modelIds ?? []).map((nativeModelId) => ({
          nativeModelId,
        })),
    );
    setResults(editProvider?.lastTest?.apis ?? {});
    setOutcome(null);
    setShowDetails(!!editProvider);
    setKeyRequested(false);
    setDirty(false);
  }, [open, editProvider]);

  useEffect(() => {
    const field = focusRequest.current;
    if (!field) return;
    focusRequest.current = null;
    document.getElementById(FIELD_IDS[field])?.focus();
  }, [outcome, keyRequested]);

  useSettingsDraft(open && dirty, () => onOpenChange(false), open && isSaving);

  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setDirty(true);
    };

  // A Test answers for the URL and key it ran with. Editing either makes a
  // pending answer stale, and a new Test can start right away.
  const editProbe = (set: (value: string) => void) => (value: string) => {
    testRun.current += 1;
    setTesting(false);
    edit(set)(value);
  };

  const showOutcome = (next: GatewayTestOutcome) => {
    if (next.focus === "secret") setKeyRequested(true);
    focusRequest.current = next.focus ?? null;
    setOutcome(next);
  };

  const runTest = async (runtimeLocation: GatewayRuntimeLocation = runtime) => {
    if (!baseUrl.trim() || testing) return;
    const needsKey = inspectorTestKeyOutcome(
      editProvider,
      runtimeLocation,
      secret,
    );
    if (needsKey) {
      showOutcome(needsKey);
      return;
    }
    const run = ++testRun.current;
    setTesting(true);
    setOutcome(null);
    let response: Awaited<ReturnType<typeof testConnection>>;
    try {
      response = await testConnection({
        runtimeLocation,
        baseUrl: baseUrl.trim(),
        ...(secret.trim() ? { secret: secret.trim() } : {}),
        ...(editProvider ? { providerKey: editProvider.providerKey } : {}),
      });
    } finally {
      if (run === testRun.current) setTesting(false);
    }
    // The dialog was reset or reopened for another connection meanwhile.
    if (run !== testRun.current) return;
    const next = gatewayTestOutcome(response);
    if (!("error" in response)) {
      setResults(
        Object.fromEntries(
          GATEWAY_APIS.flatMap((api) => {
            const result = response.apis[api]?.result;
            return result ? [[api, result]] : [];
          }),
        ),
      );
      const answered = apisFromTest(response);
      if (answered.length > 0) setApis(answered);
      if (response.models.length > 0) {
        setModels((current) => modelsFromTest(response, current));
      }
      if (response.reachable && !response.refusal) {
        setShowDetails(true);
        if (!editProvider && !name.trim())
          setName(suggestedGatewayName(baseUrl));
        setDirty(true);
      }
    }
    showOutcome(next);
  };

  const trimmedName = name.trim();
  const keyProblem = baseUrlKeyProblem(editProvider, baseUrl, secret);
  const nameProblem = /[/:]/.test(trimmedName)
    ? "Use a name without slashes or colons."
    : !editProvider &&
        existingProviderKeys.includes(providerKeyFor(trimmedName))
      ? `A gateway named "${trimmedName}" already exists. Choose another name.`
      : null;
  const canSave =
    showDetails &&
    !!trimmedName &&
    !nameProblem &&
    !!baseUrl.trim() &&
    !keyProblem &&
    apis.length > 0 &&
    models.length > 0;
  const worksWith = gatewayWorksWith({
    apis,
    runtimeLocation: runtime,
    models,
    requireOrgKeys,
  });

  const save = () =>
    void onSave({
      providerKey: editProvider?.providerKey ?? providerKeyFor(trimmedName),
      displayName: trimmedName,
      baseUrl: baseUrl.trim(),
      runtimeLocation: runtime,
      apis,
      models,
      ...(secret.trim() ? { secret: secret.trim() } : {}),
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="text-left">
            {editProvider
              ? `Edit ${trimmedName || "gateway"}`
              : "Add a gateway"}
          </DialogTitle>
          <DialogDescription className="text-left">
            Enter the gateway's base URL and key, then test it. The test fills
            in the rest.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void runTest();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={FIELD_IDS.baseUrl}>Base URL</Label>
            <Input
              id={FIELD_IDS.baseUrl}
              type="url"
              value={baseUrl}
              onChange={(event) => editProbe(setBaseUrl)(event.target.value)}
              placeholder="https://litellm.example.com/v1"
              aria-invalid={!!keyProblem || outcome?.focus === "baseUrl"}
              aria-describedby={
                keyProblem ? "gateway-base-url-problem" : undefined
              }
            />
            {keyProblem ? (
              <p
                id="gateway-base-url-problem"
                className="text-sm text-destructive"
              >
                {keyProblem}
              </p>
            ) : null}
          </div>
          <ProviderKeyField
            id={FIELD_IDS.secret}
            configured={
              !!editProvider?.hasSecret && !keyProblem && !keyRequested
            }
            value={secret}
            onChange={editProbe(setSecret)}
            optional={!keyProblem}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={!baseUrl.trim() || testing}
          >
            {testing ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {testing ? "Testing..." : "Test"}
          </Button>
        </form>

        {outcome ? (
          <GatewayTestAlert
            outcome={outcome}
            onUseInspector={() => {
              edit(setRuntime)("local");
              void runTest("local");
            }}
          />
        ) : null}

        {showDetails ? (
          // min-w-0 lets the models table scroll inside the dialog's grid.
          <div className="min-w-0 space-y-6">
            <div className="space-y-2">
              <Label htmlFor="gateway-name">Name</Label>
              <Input
                id="gateway-name"
                value={name}
                onChange={(event) => edit(setName)(event.target.value)}
                disabled={!!editProvider}
                aria-invalid={!!nameProblem}
              />
              {nameProblem ? (
                <p className="text-sm text-destructive">{nameProblem}</p>
              ) : null}
            </div>
            <GatewayRuntimeField value={runtime} onChange={edit(setRuntime)} />
            <div className="space-y-2">
              <GatewayApiList
                selected={apis}
                results={results}
                onChange={edit(setApis)}
              />
              {apis.length === 0 ? (
                <p className="text-sm text-destructive">
                  Choose at least one API the gateway serves.
                </p>
              ) : null}
            </div>
            <GatewayWorksWithList rows={worksWith} />
            <section aria-labelledby="gateway-models" className="space-y-2">
              <h3 id="gateway-models" className="text-sm font-medium">
                Models
              </h3>
              <GatewayModelTable
                models={models}
                catalogIds={catalogIds}
                onChange={edit(setModels)}
              />
            </section>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave || isSaving}>
            {isSaving
              ? "Saving..."
              : editProvider
                ? "Save changes"
                : "Add gateway"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
