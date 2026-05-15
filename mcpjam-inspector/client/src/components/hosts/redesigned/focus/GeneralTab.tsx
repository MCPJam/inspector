import { Input } from "@mcpjam/design-system/input";
import type { HostAttentionIssue } from "../types";
import { FieldRow, FocusBlock } from "./primitives";
import { fieldsWithIssues } from "./useHostDraftValidation";

interface GeneralTabProps {
  hostDisplayName: string;
  onHostDisplayNameChange: (value: string) => void;
  attention: ReadonlyArray<HostAttentionIssue>;
}

export function GeneralTab({
  hostDisplayName,
  onHostDisplayNameChange,
  attention,
}: GeneralTabProps) {
  const issues = fieldsWithIssues(attention, "general");

  return (
    <div className="flex flex-col gap-4">
      <FocusBlock
        title="Host identity"
        subtitle="Name shown in the Connect host picker and this editor."
      >
        <FieldRow
          label="Name"
          description="A label for this host configuration within your project."
          control={
            <Input
              id="host-display-name"
              value={hostDisplayName}
              onChange={(event) =>
                onHostDisplayNameChange(event.target.value)
              }
              placeholder="Host name"
              aria-label="Host name"
              className={
                "h-8 w-[260px] rounded-md text-[13px] " +
                (issues.has("hostDisplayName")
                  ? "border-amber-500"
                  : "border-input")
              }
            />
          }
        />
      </FocusBlock>
    </div>
  );
}
