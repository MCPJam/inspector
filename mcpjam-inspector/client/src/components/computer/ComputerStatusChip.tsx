import { Badge } from "@mcpjam/design-system/badge";
import type { ComputerStatus } from "@/hooks/useProjectComputer";

type ChipSpec = {
  label: string;
  variant: "default" | "secondary" | "outline" | "destructive";
};

// Maps the provider-side lifecycle status to a user-facing chip. Transitional
// "warming up" states collapse to one "Starting…" label so the chip doesn't
// flicker between requested/provisioning/waking.
const SPECS: Record<ComputerStatus, ChipSpec> = {
  requested: { label: "Starting…", variant: "secondary" },
  provisioning: { label: "Starting…", variant: "secondary" },
  waking: { label: "Waking…", variant: "secondary" },
  ready: { label: "Ready", variant: "default" },
  hibernating: { label: "Asleep", variant: "outline" },
  deleting: { label: "Deleting…", variant: "outline" },
  deleted: { label: "Deleted", variant: "outline" },
  error: { label: "Error", variant: "destructive" },
};

export function ComputerStatusChip({
  status,
}: {
  status: ComputerStatus | null | undefined;
}) {
  if (status === undefined) {
    return (
      <Badge variant="outline" className="opacity-60">
        Loading…
      </Badge>
    );
  }
  if (status === null) {
    return <Badge variant="outline">No computer</Badge>;
  }
  const spec = SPECS[status];
  return <Badge variant={spec.variant}>{spec.label}</Badge>;
}
