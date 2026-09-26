/** Retain callbacks until the main renderer installs its IPC listener. */
export class OAuthCallbackDelivery {
  private ready = false;
  private pending = new Set<string>();
  constructor(private send: (url: string) => void) {}
  enqueue(url: string) {
    this.pending.add(url);
    this.flush();
  }
  setReady(ready: boolean) {
    this.ready = ready;
    this.flush();
  }
  private flush() {
    if (!this.ready) return;
    for (const url of this.pending) {
      this.send(url);
      this.pending.delete(url);
    }
  }
}
