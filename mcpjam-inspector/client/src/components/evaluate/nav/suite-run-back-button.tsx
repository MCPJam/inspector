/**
 * The Suite run page's Back button. It returns to the page the user came
 * from, which the link that brought them names in router state, and to the
 * suite otherwise (a direct load or a shared link). The breadcrumb is built
 * from the route; Back is the one control that depends on how the user
 * arrived.
 */
import { ArrowLeft } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  useEvalNavBackTarget,
  useEvaluateNavNavigate,
} from "./use-evaluate-nav-navigate";

export function SuiteRunBackButton({ suiteId }: { suiteId: string }) {
  const navigate = useEvaluateNavNavigate();
  const target = useEvalNavBackTarget();
  const label = `Back to ${target?.place ?? "suite"}`;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 shrink-0 gap-1.5 px-2.5"
      title={label}
      aria-label={label}
      data-testid="suite-run-back"
      onClick={() =>
        navigate(target?.path ?? { type: "suite-overview", suiteId }, "back")
      }
    >
      <ArrowLeft className="size-3.5" aria-hidden />
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">Back</span>
    </Button>
  );
}
