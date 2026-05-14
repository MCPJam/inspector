import { HostPicker } from "@/components/hosts/HostPicker";
import { usePreviewedHostId } from "@/hooks/use-previewed-host-id";

interface PlaygroundHeaderProps {
  projectId?: string;
}

/**
 * Playground toolbar — shows the same host picker as Connect's
 * `HostOverlayBar`, bound to the shared `previewedHostId` localStorage.
 * Changing the host here updates Connect (and vice versa) without any
 * extra wiring.
 */
export function PlaygroundHeader({ projectId }: PlaygroundHeaderProps) {
  const [hostId, setHostId] = usePreviewedHostId(projectId ?? null);

  if (!projectId) return null;

  return (
    <div className="flex h-full min-w-0 items-center gap-1">
      <div className="hidden min-w-0 sm:block [&_button]:h-7 [&_button]:rounded-md [&_button]:border-transparent [&_button]:bg-transparent [&_button]:px-2 [&_button]:text-xs [&_button]:shadow-none [&_button]:hover:bg-accent">
        <HostPicker
          projectId={projectId}
          value={hostId}
          onChange={setHostId}
          placeholder="Select a host"
          includeNone={false}
        />
      </div>
    </div>
  );
}
