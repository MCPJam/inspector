let activeTunnel: any | null = null;
let publicUrl: string | null = null;
let starting: Promise<string> | null = null;

export async function ensureTunnel(port: number): Promise<string> {
  if (publicUrl) return publicUrl;
  if (starting) return starting;

  starting = (async () => {
    const lt = await import("localtunnel");
    const create = (lt as any)?.default || (lt as any);
    const tunnel = await create({ port });
    activeTunnel = tunnel;
    publicUrl = tunnel.url;
    if (!publicUrl) throw new Error("Failed to establish localtunnel");
    console.log(`[tunnel] established: ${publicUrl}`);
    return publicUrl;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export function getTunnelUrl(): string | null {
  return publicUrl;
}

export async function closeTunnel(): Promise<void> {
  try {
    if (activeTunnel && typeof activeTunnel.close === "function") {
      await activeTunnel.close();
    }
    console.log("[tunnel] closed");
  } finally {
    activeTunnel = null;
    publicUrl = null;
  }
}

