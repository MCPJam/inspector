import { useEffect } from "react";
import { toast } from "@/lib/toast";

/**
 * The query param the backend adds to a plan checkout's success URL (never
 * to its cancel URL), so a return can tell a finished upgrade from a
 * cancelled one.
 */
export const PLAN_CHECKOUT_RETURN_PARAM = "plan_checkout";

export const PLAN_CHECKOUT_SUCCESS_MESSAGE =
  "Plan upgraded. If an agent sent you here, go back and tell it to continue.";

/**
 * After a completed plan checkout, tell the person to go back to their agent:
 * a credit refusal sends them here with an upgrade link, and the agent waits to
 * be told to continue rather than retrying on its own. Mounted once at the app
 * root, because the checkout returns to whichever page started it.
 */
export function usePlanCheckoutReturn(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get(PLAN_CHECKOUT_RETURN_PARAM) !== "success") return;

    params.delete(PLAN_CHECKOUT_RETURN_PARAM);
    const search = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (search ? `?${search}` : "") + window.location.hash,
    );
    toast.success(PLAN_CHECKOUT_SUCCESS_MESSAGE);
  }, []);
}
