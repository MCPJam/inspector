/**
 * Shared timing/easing for the Connect-tab "Snappy Canyon" transition between
 * the Servers grid and the Host canvas. Mirrors the prototype at
 * /tmp/host-transition-demo.html — bezier `[0.32, 0.72, 0, 1]` is the
 * camera-ease (zoom-out), and the durations match the demo's --t-* tokens.
 */

export const SNAPPY_CAMERA = {
  duration: 1.15,
  ease: [0.32, 0.72, 0, 1] as [number, number, number, number],
};

export const SNAPPY_RAIL = {
  duration: 0.9,
  ease: [0.32, 0.72, 0, 1] as [number, number, number, number],
};

/**
 * Host canvas inner-content entrance. Slight delay so the camera fade
 * "opens" first, then the host card scales into view — gives the click a
 * second beat instead of cutting straight to the final state.
 */
export const SNAPPY_HOST_REVEAL = {
  duration: 0.7,
  delay: 0.18,
  ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
};

export type ViewPhase = "servers" | "host";

export const SERVER_CARD_LAYOUT_ID = (serverId: string) =>
  `connect-server:${serverId}`;
