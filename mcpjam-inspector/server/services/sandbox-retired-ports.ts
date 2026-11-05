import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createLocalStateMutationLock } from "../utils/harness/local/local-state-lock.js";
import { localHarnessStateRoot } from "../utils/harness/local/grants.js";

const registrySchema = z
  .object({
    version: z.literal(1),
    ports: z.array(z.number().int().min(1).max(65535)).max(65535),
  })
  .strict();
const MAX_REGISTRY_BYTES = 1024 * 1024;

/** A port names an origin, so retirement survives both process exit and later admissions. */
export class RetiredSandboxPorts {
  private readonly lock: ReturnType<typeof createLocalStateMutationLock>;
  constructor(private readonly root = localHarnessStateRoot) {
    this.lock = createLocalStateMutationLock({
      rootDir: root,
      lockFileName: "sandbox-view-ports.lock",
      resourceLabel: "App origin registry",
    });
  }

  reserve(port: number): Promise<boolean> {
    return this.lock(async () => {
      const file = join(this.root(), "sandbox-view-ports.json");
      let ports: number[];
      try {
        if ((await stat(file)).size > MAX_REGISTRY_BYTES)
          throw new Error("App origin registry exceeds its size limit");
        ports = registrySchema.parse(
          JSON.parse(await readFile(file, "utf8")),
        ).ports;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error(
            "App origin registry could not be verified; no origin was reused",
            { cause: error },
          );
        ports = [];
      }
      if (ports.includes(port)) return false;
      if (ports.length >= 65535)
        throw new Error(
          "App origins are exhausted; an explicit origin reset is required",
        );
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({ version: 1, ports: [...ports, port] }),
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
      return true;
    });
  }
}
export const retiredSandboxPorts = new RetiredSandboxPorts();
