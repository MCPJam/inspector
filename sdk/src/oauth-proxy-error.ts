/**
 * The pinned transport's error class, in its own module.
 *
 * It lives apart from `oauth-proxy.ts` only so that `oauth/pinned-dns.ts` — the
 * shared DNS half that `oauth-proxy.ts` itself imports — can throw it without
 * an import cycle. `oauth-proxy.ts` re-exports the symbol, so every existing
 * `import { OAuthProxyError } from "./oauth-proxy.js"` keeps working and
 * `instanceof` keeps meaning one class.
 */
export class OAuthProxyError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
