import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { TriangleAlert } from "lucide-react";
import {
  CLI_REPORTING_VERSION,
  oldRunCliVersion,
} from "../../../../shared/cli-reporting-version";
import type { EvalSuiteRun } from "./types";

export function RunCliVersionNotice({
  run,
}: {
  run: Pick<EvalSuiteRun, "launcher">;
}) {
  const version = oldRunCliVersion(run);
  if (!version) return null;
  return (
    <Alert variant="warning" className="mb-4">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>This run used an older CLI ({version})</AlertTitle>
      <AlertDescription>
        <p>
          Local HTML and JUnit reports from CLI versions before{" "}
          {CLI_REPORTING_VERSION} can omit tool calls, tokens and scores.
        </p>
        <p>Update and rerun to get the current report details.</p>
        <code className="break-all text-foreground">
          npm install -g @mcpjam/cli@latest
        </code>
        <p>
          In CI, remove an older <code>cli-version</code> pin or set it to{" "}
          <code>6</code>.
        </p>
      </AlertDescription>
    </Alert>
  );
}
