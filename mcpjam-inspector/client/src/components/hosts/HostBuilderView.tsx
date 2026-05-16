import { HostBuilderViewRedesigned } from "./redesigned/HostBuilderViewRedesigned";

interface HostBuilderViewProps {
  hostId: string;
  projectId: string;
  onBack: () => void;
}

export function HostBuilderView(props: HostBuilderViewProps) {
  return <HostBuilderViewRedesigned {...props} />;
}
