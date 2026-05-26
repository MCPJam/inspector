import { ClientBuilderViewRedesigned } from "./redesigned/ClientBuilderViewRedesigned";

interface HostBuilderViewProps {
  hostId: string;
  projectId: string;
}

export function ClientBuilderView(props: HostBuilderViewProps) {
  return <ClientBuilderViewRedesigned {...props} />;
}
