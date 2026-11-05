import { create } from "zustand";
import { navigatePlaygroundEvalsRoute } from "./create-suite-navigation";

/**
 * What the create-suite page opens with: a name from the agent command
 * (`ui_open_eval_suite_form`), or a name and server from an empty-state server
 * card. A store rather than page state, so a page that is not the create page
 * (the new Evaluate landing) can open it prefilled. The user still reviews and
 * submits.
 */
interface CreateSuitePrefill {
  name: string | null;
  serverId: string | null;
}

const useCreateSuitePrefillStore = create<CreateSuitePrefill>(() => ({
  name: null,
  serverId: null,
}));

export function useCreateSuitePrefill(): CreateSuitePrefill {
  const name = useCreateSuitePrefillStore((state) => state.name);
  const serverId = useCreateSuitePrefillStore((state) => state.serverId);
  return { name, serverId };
}

/** Opens the create-suite page, blank unless a prefill is given. */
export function openCreateSuite(prefill: Partial<CreateSuitePrefill> = {}) {
  useCreateSuitePrefillStore.setState({
    name: prefill.name ?? null,
    serverId: prefill.serverId ?? null,
  });
  navigatePlaygroundEvalsRoute({ type: "create" });
}

export function clearCreateSuitePrefill() {
  useCreateSuitePrefillStore.setState({ name: null, serverId: null });
}
