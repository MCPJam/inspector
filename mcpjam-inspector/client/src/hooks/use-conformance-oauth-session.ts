import { useCallback, useEffect, useRef } from "react";
import { cancelOAuthConformance } from "@/lib/apis/mcp-conformance-api";
import { toast } from "@/lib/toast";

/** Release the server-owned OAuth wait when a bounded run leaves the page. */
export function useConformanceOAuthSession() {
  const session = useRef<string | null>(null);
  const remember = useCallback((id: string) => { session.current = id; }, []);
  const forget = useCallback(() => { session.current = null; }, []);
  const cancel = useCallback(() => {
    const id = session.current;
    session.current = null;
    if (id) {
      void cancelOAuthConformance(id).catch(() => {
        toast.error("Could not stop the OAuth checks. They will stop at the run timeout.");
      });
    }
  }, []);
  useEffect(() => cancel, [cancel]);
  return { remember, forget, cancel };
}
