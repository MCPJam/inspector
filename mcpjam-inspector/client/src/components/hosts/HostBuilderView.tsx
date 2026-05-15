import { HostBuilderViewRedesigned } from "./redesigned/HostBuilderViewRedesigned";

interface HostBuilderViewProps {
  hostId: string;
  projectId: string;
  onBack: () => void;
  /** When set, the redesigned builder shows a host switcher in the header. */
  onSwitchHost?: (hostId: string) => void;
}

export function HostBuilderView(props: HostBuilderViewProps) {
  return <HostBuilderViewRedesigned {...props} />;
}
