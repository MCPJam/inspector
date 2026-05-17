import { HostBuilderViewRedesigned } from "./redesigned/HostBuilderViewRedesigned";

interface HostBuilderViewProps {
  hostId: string;
  projectId: string;
}

export function HostBuilderView(props: HostBuilderViewProps) {
  return <HostBuilderViewRedesigned {...props} />;
}
