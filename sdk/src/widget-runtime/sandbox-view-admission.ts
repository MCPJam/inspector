/** Host-admitted document bytes and policy, prepared before an App is mounted. */
export interface SandboxViewSource {
  serverId: string;
  resourceUri: string;
  toolCallId: string;
}

export interface SandboxViewCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

export interface SandboxViewPolicy {
  csp?: SandboxViewCsp | null;
  cspDirectives?: Record<string, string[]>;
  cspSubtypePolicy?: {
    cspConnectDomains?: { fetch?: boolean; xhr?: boolean; websocket?: boolean };
    cspResourceDomains?: {
      script?: boolean;
      stylesheet?: boolean;
      image?: boolean;
      font?: boolean;
      media?: boolean;
    };
  };
  permissive: boolean;
}

export interface PrepareSandboxViewRequest {
  /** Stable random identifier for this mounted/retained host instance. */
  viewInstanceId: string;
  /** Prior admission to renew only when its bytes, policy and owner still match. */
  admissionId?: string;
  source: SandboxViewSource;
  /** Receipt issued with live resource bytes after metadata resolution. */
  sourceReceipt?: string;
  html: string;
  policy: SandboxViewPolicy;
  /** Explicit debugger/replay mode is distinct from declared-policy rendering. */
  mode: "declared" | "debugger";
  hostOrigin: string;
}

export interface PreparedSandboxView {
  admissionId: string;
  proxyUrl: string;
  htmlSha256: string;
  expiresAt: number;
}

export interface ReleaseSandboxViewRequest {
  admissionId: string;
}
