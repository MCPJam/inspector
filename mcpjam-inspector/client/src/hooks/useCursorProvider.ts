import { useAction, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

export type CursorIdentity = {
  kind: "user" | "service_account";
  label: string;
};
export type CheckedCursorKey = { identity: CursorIdentity; modelCount: number };
export type CursorProviderView = {
  configured: boolean;
  identity?: CursorIdentity;
  modelCount?: number;
  modelsRefreshedAt?: number;
  modelsRefreshStatus?: "ready" | "failed";
};
type Scope = { organizationId: string; harnessId: "cursor" };
const read = makeFunctionReference<"query", Scope, CursorProviderView>(
  "organizationHarnessCredentials:getForOrganization",
);
const check = makeFunctionReference<
  "action",
  Scope & { key: string },
  CheckedCursorKey
>("organizationHarnessCredentialsNode:checkKey");
const save = makeFunctionReference<
  "action",
  Scope & { key: string; expectedIdentity: CursorIdentity },
  CheckedCursorKey
>("organizationHarnessCredentialsNode:saveKey");
const remove = makeFunctionReference<"mutation", Scope, { removed: boolean }>(
  "organizationHarnessCredentials:removeKey",
);
const refresh = makeFunctionReference<"action", Scope, { applied: boolean }>(
  "organizationHarnessModelsNode:refreshModels",
);

export function useCursorProvider(organizationId: string) {
  const scope: Scope = { organizationId, harnessId: "cursor" };
  const view = useQuery(read, scope);
  const checkKey = useAction(check);
  const saveKey = useAction(save);
  const removeKey = useMutation(remove);
  const refreshModels = useAction(refresh);
  return {
    view,
    checkKey: (key: string) => checkKey({ ...scope, key }),
    saveKey: (key: string, expectedIdentity: CursorIdentity) =>
      saveKey({ ...scope, key, expectedIdentity }),
    removeKey: () => removeKey(scope),
    refreshModels: () => refreshModels(scope),
  };
}
