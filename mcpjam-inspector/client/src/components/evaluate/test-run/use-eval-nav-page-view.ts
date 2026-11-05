import { useEffect } from "react";
import { getAppRouter } from "@/router-ref";
import type { EvalNavPageId } from "../nav/eval-nav-pages";
import { trackEvalNav, type EvalNavArrival } from "../nav/eval-nav-events";

/**
 * How the reader reached the page, from the router's own history.
 *
 * The first entry of the tab is a direct open (a pasted or shared link); a
 * later POP is Back or Forward; anything else is an in-app link. Crumbs and
 * links are not told apart: the router does not record which one was clicked.
 */
export function evalNavArrival(): EvalNavArrival {
  const router = getAppRouter();
  const index = (
    typeof window !== "undefined" ? window.history.state : null
  ) as { idx?: number } | null;
  if (!router || !index?.idx) return "direct";
  return router.state.historyAction === "POP" ? "back" : "link";
}

/** Fires `eval_nav_page_viewed` once per page and address it names. */
export function useEvalNavPageView(page: EvalNavPageId, addressKey: string) {
  useEffect(() => {
    trackEvalNav("eval_nav_page_viewed", {
      page,
      arrived_via: evalNavArrival(),
    });
  }, [page, addressKey]);
}
