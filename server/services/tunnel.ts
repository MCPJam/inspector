let activeTunnel: any | null = null;
let publicUrl: string | null = null;
let starting: Promise<string> | null = null;

export async function ensureTunnel(port: number): Promise<string> {
  if (publicUrl) return publicUrl;
  if (starting) return starting;

  starting = (async () => {
    const lt = await import("localtunnel");
    const create = (lt as any)?.default || (lt as any);
    const opts: any = { port };
    const sub = process.env.LT_SUBDOMAIN || process.env.LOCALTUNNEL_SUBDOMAIN;
    const host = process.env.LT_HOST || process.env.LOCALTUNNEL_HOST;
    if (sub) opts.subdomain = sub;
    if (host) opts.host = host;
    const tunnel = await create(opts);
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
