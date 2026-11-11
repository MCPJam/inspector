/**
 * A custom provider being added or configured, and its connection Test: the
 * base URL and key, where calls come from, and the APIs and models a Test
 * fills in. The add dialog and the configure panel are two views of it.
 */
import { useEffect, useRef, useState } from "react";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import {
  GATEWAY_APIS,
  type GatewayApi,
  type GatewayApiTestResult,
  type GatewayConnectionTestResult,
  type GatewayModel,
} from "@/shared/gateway-connection";
import { useSettingsDraft } from "../../settings/SettingsDraftProvider";
import {
  apisFromTest,
  baseUrlKeyProblem,
  gatewayTestOutcome,
  inspectorTestKeyOutcome,
  modelsFromTest,
  type GatewayField,
  type GatewayTestOutcome,
} from "./gateway-test-outcome";
import type { GatewayRuntimeLocation } from "./gateway-works-with";
import { useGatewayConnectionTest } from "./use-gateway-connection-test";

/** The base URL and key inputs, by field. */
export const FIELD_IDS: Record<GatewayField, string> = {
  baseUrl: "gateway-base-url",
  secret: "gateway-secret",
};

export type GatewayDraft = ReturnType<typeof useGatewayDraft>;

export function useGatewayDraft({
  open,
  onOpenChange,
  organizationId,
  editProvider,
  isSaving,
  onFieldProblem,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  /** The saved provider being configured; null while adding one. */
  editProvider: OrgModelProvider | null;
  isSaving: boolean;
  /** A Test blamed a field: show it before focus moves there. */
  onFieldProblem?: (field: GatewayField) => void;
}) {
  const testConnection = useGatewayConnectionTest(organizationId);
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [runtime, setRuntime] = useState<GatewayRuntimeLocation>("cloud");
  const [apis, setApis] = useState<GatewayApi[]>([]);
  const [models, setModels] = useState<GatewayModel[]>([]);
  /** The latest Test that answered, for the URL and key now typed. */
  const [tested, setTested] = useState<GatewayConnectionTestResult | null>(
    null,
  );
  const [outcome, setOutcome] = useState<GatewayTestOutcome | null>(null);
  const [testing, setTesting] = useState(false);
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
    setRuntime(editProvider?.runtimeLocation ?? "cloud");
    setApis(editProvider?.apis ?? []);
    setModels(
      editProvider?.models ??
        (editProvider?.modelIds ?? []).map((nativeModelId) => ({
          nativeModelId,
        })),
    );
    setTested(null);
    setOutcome(null);
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
    <T>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setDirty(true);
    };

  // A Test answers for the URL and key it ran with. Editing either makes a
  // pending answer stale, drops a finished one, and a new Test can start.
  const editProbe = (set: (value: string) => void) => (value: string) => {
    testRun.current += 1;
    setTesting(false);
    setTested(null);
    setOutcome(null);
    edit(set)(value);
  };

  const showOutcome = (next: GatewayTestOutcome) => {
    if (next.focus) onFieldProblem?.(next.focus);
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
    setTested(null);
    // A new provider takes its APIs and models from its latest Test alone.
    if (!editProvider) {
      setApis([]);
      setModels([]);
    }
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
    // The draft was reset or reopened for another provider meanwhile.
    if (run !== testRun.current) return;
    const next = gatewayTestOutcome(response);
    if (!("error" in response)) {
      setTested(response);
      const answered = apisFromTest(response);
      if (answered.length > 0) setApis(answered);
      if (response.models.length > 0) {
        setModels((current) => modelsFromTest(response, current));
      }
      if (response.reachable && !response.refusal) setDirty(true);
    }
    showOutcome(next);
  };

  // What the latest Test said of each API, else the saved provider's last Test.
  const results: Partial<Record<GatewayApi, GatewayApiTestResult>> = tested
    ? Object.fromEntries(
        GATEWAY_APIS.flatMap((api) => {
          const result = tested.apis[api]?.result;
          return result ? [[api, result]] : [];
        }),
      )
    : (editProvider?.lastTest?.apis ?? {});

  return {
    baseUrl,
    secret,
    runtime,
    apis,
    models,
    results,
    tested,
    outcome,
    testing,
    keyRequested,
    /** The latest Test reached the provider and found something to save. */
    passed:
      !!tested &&
      tested.reachable &&
      !tested.refusal &&
      outcome?.tone !== "destructive",
    dirty,
    keyProblem: baseUrlKeyProblem(editProvider, baseUrl, secret),
    setBaseUrl: editProbe(setBaseUrl),
    setSecret: editProbe(setSecret),
    setRuntime: edit(setRuntime),
    setApis: edit(setApis),
    setModels: edit(setModels),
    runTest,
    /** The fix for a private address MCPJam's servers refuse. */
    testFromInspector: () => {
      edit(setRuntime)("local");
      void runTest("local");
    },
    /** The save's connection fields; the caller adds the key and name. */
    connection: {
      baseUrl: baseUrl.trim(),
      runtimeLocation: runtime,
      apis,
      models,
      ...(secret.trim() ? { secret: secret.trim() } : {}),
    },
  };
}
