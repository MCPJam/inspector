import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { paneTargetKey, type ComparePaneTarget } from "@/lib/compare-panes";

export interface ComparePaneTargetOption {
  target: ComparePaneTarget;
  label: string;
}

/**
 * What a pane runs: one of the project's clients, or, where environments are
 * visible, one of its saved environments. Choosing another starts a new
 * conversation in that pane.
 */
export function ComparePaneTargetSelect({
  label,
  value,
  clients,
  environments,
  onChange,
}: {
  /** The pane's current name, for the accessible name. */
  label: string;
  value: ComparePaneTarget;
  clients: readonly ComparePaneTargetOption[];
  /** Empty when environments are hidden; the group is then left out. */
  environments: readonly ComparePaneTargetOption[];
  onChange: (target: ComparePaneTarget) => void;
}) {
  const options = [...clients, ...environments];
  return (
    <Select
      value={paneTargetKey(value)}
      onValueChange={(next) => {
        const option = options.find(
          (entry) => paneTargetKey(entry.target) === next,
        );
        if (option) onChange(option.target);
      }}
    >
      <SelectTrigger
        size="sm"
        className="w-full"
        aria-label={`What ${label} runs`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {environments.length > 0 ? <SelectLabel>Clients</SelectLabel> : null}
          {clients.map((option) => (
            <SelectItem
              key={paneTargetKey(option.target)}
              value={paneTargetKey(option.target)}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
        {environments.length > 0 ? (
          <SelectGroup>
            <SelectLabel>Environments</SelectLabel>
            {environments.map((option) => (
              <SelectItem
                key={paneTargetKey(option.target)}
                value={paneTargetKey(option.target)}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );
}
