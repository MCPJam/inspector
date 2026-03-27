export type TestingSurface = "explore" | "runs";

export function readTestingSurfaceFromHash(hashValue: string): TestingSurface {
  const hash = hashValue.replace(/^#/, "");
  const [path, queryString] = hash.split("?");

  if (path.startsWith("/ci-evals")) {
    return "runs";
  }

  const params = new URLSearchParams(queryString || "");
  // Legacy ?surface=suites bookmarks — treat as Explore (Suites tab removed)
  if (params.get("surface") === "suites") {
    return "explore";
  }
  return "explore";
}

/** Strips legacy `surface` query params from evals hashes. */
export function withTestingSurface(hash: string): string {
  const normalizedHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const [path, queryString] = normalizedHash.split("?");
  const params = new URLSearchParams(queryString || "");
  params.delete("surface");

  const nextQuery = params.toString();
  return `#${path}${nextQuery ? `?${nextQuery}` : ""}`;
}
