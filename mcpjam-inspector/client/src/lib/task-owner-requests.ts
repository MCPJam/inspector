/** Owner snapshots belong to requests, including responses that arrive late. */
export class TaskOwnerRequests {
  private readonly scopes = new Map<string, string>();

  capture(requestId: string, scope: string | undefined): string | undefined {
    if (!scope || this.scopes.has(requestId)) return undefined;
    this.scopes.set(requestId, scope);
    const oldest = this.scopes.keys().next().value;
    if (this.scopes.size > 128 && oldest !== undefined)
      this.scopes.delete(oldest);
    return requestId;
  }

  resolve(requestId: string | undefined): string | undefined {
    return requestId === undefined ? undefined : this.scopes.get(requestId);
  }
}
