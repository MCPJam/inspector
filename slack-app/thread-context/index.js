/**
 * Per-thread session state, shared with every other surface.
 *
 * `tenantId` is the Slack team id here; the store keys by tenant first so two
 * workspaces that mint the same channel and thread ids cannot see each other's
 * threads.
 */
import { ThreadContextStore } from '@mcpjam/surface-core';

export { ThreadContextStore };
export const sessionStore = new ThreadContextStore();
