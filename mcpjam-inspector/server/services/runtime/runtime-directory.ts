export type RuntimeActorStatus = "active" | "evicted";

export interface RuntimeDirectoryRecord {
  tenantId: string;
  shardId: string;
  actorId: string;
  status: RuntimeActorStatus;
  lastSeenAt: number;
  tier: "shared" | "dedicated";
}

export interface RuntimeDirectory {
  get(tenantId: string): RuntimeDirectoryRecord | undefined;
  upsert(record: RuntimeDirectoryRecord): void;
  remove(tenantId: string): void;
}

export class InMemoryRuntimeDirectory implements RuntimeDirectory {
  private readonly records = new Map<string, RuntimeDirectoryRecord>();

  get(tenantId: string): RuntimeDirectoryRecord | undefined {
    return this.records.get(tenantId);
  }

  upsert(record: RuntimeDirectoryRecord): void {
    this.records.set(record.tenantId, record);
  }

  remove(tenantId: string): void {
    this.records.delete(tenantId);
  }
}
