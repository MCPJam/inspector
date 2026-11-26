/**
 * Replace one anchor inside one source region of a pinned vendor bridge
 * bundle (its `//#region <source>` markers), or refuse a bridge that changed:
 * an adapter upgrade that moves the code a patch targets is qualified again
 * rather than patched somewhere it was never reviewed. Applying a patch twice
 * leaves the bridge as the first application did.
 */
export function replaceInRegion(source: string, region: string, before: string, after: string): string {
  const start = source.indexOf(`//#region ${region}`);
  const end = source.indexOf("//#endregion", start);
  if (start < 0 || end < start) throw new Error(`The pinned bridge's ${region} region changed. Requalify the adapter.`);
  const original = source.slice(start, end);
  if (original.split(after).length === 2 && !original.replace(after, "").includes(before)) return source;
  if (original.split(before).length !== 2) throw new Error(`The pinned bridge's ${region} anchor changed. Requalify the adapter.`);
  return source.slice(0, start) + original.replace(before, after) + source.slice(end);
}
