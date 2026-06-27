import { Badge } from "@mcpjam/design-system/badge";
import type { EnvironmentBuildView } from "@/hooks/useComputerEnvironments";

/** Build-status chip for an environment, mirroring `ComputerStatusChip`. */
export function EnvironmentBuildBadge({
  build,
}: {
  build: EnvironmentBuildView | null | undefined;
}) {
  if (!build) return <Badge variant="outline">Not built</Badge>;
  switch (build.status) {
    case "ready":
      return <Badge variant="default">Ready</Badge>;
    case "failed":
      return <Badge variant="destructive">Build failed</Badge>;
    case "queued":
    case "building":
    default:
      return <Badge variant="secondary">Building…</Badge>;
  }
}
