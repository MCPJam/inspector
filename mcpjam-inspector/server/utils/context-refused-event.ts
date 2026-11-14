/**
 * An App context update refused before anything was stored: a size, rate
 * or memory budget, with the sizes it was judged on. Never the context.
 */
export type PluginContextRefusedEvent = {
  code: string;
  statusCode: number;
  budget?: string;
  actual?: number;
  allowed?: number;
};
