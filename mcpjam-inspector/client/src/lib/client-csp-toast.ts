import type { ClientCspBlock } from "./csp-violation-telemetry";

interface MountToast {
  toolCallId: string;
  mountId: string;
  id: string;
  clientName?: string;
  blocks: Map<string, ClientCspBlock>;
  timer?: ReturnType<typeof setTimeout>;
}

/** One notification per live app mount, independent of telemetry rate limits. */
export class ClientCspToastGroup {
  private readonly mounts = new Map<string, MountToast>();
  private readonly retired = new Set<string>();

  constructor(
    private readonly show: (
      id: string,
      clientName: string,
      blocks: ClientCspBlock[],
    ) => void,
    private readonly dismiss: (id: string) => void,
  ) {}

  activate(
    toolCallId: string,
    mountId: string | number,
    surface = "inline",
  ): void {
    if (this.isStale(toolCallId, mountId)) return;
    const key = JSON.stringify([toolCallId, surface]);
    const previous = this.mounts.get(key);
    if (previous?.mountId === String(mountId)) return;
    if (previous) this.remove(previous);
    this.mounts.set(key, {
      toolCallId,
      mountId: String(mountId),
      id: `client-csp:${JSON.stringify([toolCallId, surface, mountId])}`,
      blocks: new Map(),
    });
  }

  isStale(toolCallId: string, mountId: string | number): boolean {
    return this.retired.has(JSON.stringify([toolCallId, String(mountId)]));
  }

  clearMount(toolCallId: string, mountId: string | number): void {
    for (const [key, mount] of this.mounts) {
      if (mount.toolCallId !== toolCallId || mount.mountId !== String(mountId))
        continue;
      this.remove(mount);
      this.mounts.delete(key);
    }
  }

  report(
    toolCallId: string,
    mountId: string | number,
    clientName: string,
    blocks: ClientCspBlock[],
  ): void {
    const mount = [...this.mounts.values()].find(
      (mount) =>
        mount.toolCallId === toolCallId && mount.mountId === String(mountId),
    );
    if (!mount || !clientName.trim()) return;
    let changed = false;
    for (const block of blocks) {
      if (mount.blocks.has(block.capability)) continue;
      mount.blocks.set(block.capability, block);
      changed = true;
    }
    if (!changed) return;
    mount.clientName = clientName;
    if (mount.timer !== undefined) return;
    mount.timer = setTimeout(() => {
      mount.timer = undefined;
      this.show(mount.id, mount.clientName!, [...mount.blocks.values()]);
    }, 250);
  }

  clearToolCall(toolCallId: string): void {
    for (const [key, mount] of this.mounts) {
      if (mount.toolCallId !== toolCallId) continue;
      this.remove(mount);
      this.mounts.delete(key);
    }
  }

  dispose(): void {
    for (const mount of this.mounts.values()) this.remove(mount);
    this.mounts.clear();
    this.retired.clear();
  }

  private remove(mount: MountToast): void {
    this.retired.add(JSON.stringify([mount.toolCallId, mount.mountId]));
    if (mount.timer !== undefined) clearTimeout(mount.timer);
    this.dismiss(mount.id);
  }
}
