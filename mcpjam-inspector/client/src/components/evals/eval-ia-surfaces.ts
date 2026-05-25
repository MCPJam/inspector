export type EvalIaSurfaceId = "S1" | "S2" | "S3" | "S4" | "S5" | "S6";

export interface EvalIaSurfaceReference {
  id: EvalIaSurfaceId;
  title: string;
  primary: string;
  alt?: string;
  dependsOn: EvalIaSurfaceId[];
}

export const EVAL_IA_SURFACE_SEQUENCE = [
  {
    id: "S1",
    title: "Suite Dashboard / Cases",
    primary: "S1_Primary",
    alt: "S1_Alt",
    dependsOn: [],
  },
  {
    id: "S2",
    title: "Live Run",
    primary: "S2_Primary",
    alt: "S2_Alt",
    dependsOn: ["S1"],
  },
  {
    id: "S3",
    title: "Completed Run Detail",
    primary: "S3_Primary",
    alt: "S3_Alt",
    dependsOn: ["S1"],
  },
  {
    id: "S4",
    title: "Case Editor / Runner",
    primary: "S4_Primary",
    alt: "S4_Alt",
    dependsOn: ["S1"],
  },
  {
    id: "S5",
    title: "Run Compare",
    primary: "S5_Primary",
    alt: "S5_Alt",
    dependsOn: ["S3"],
  },
  {
    id: "S6",
    title: "Iteration Navigation",
    primary: "S6_Anatomy",
    alt: "S6_RouteMap",
    dependsOn: ["S2", "S3", "S4"],
  },
] as const satisfies ReadonlyArray<EvalIaSurfaceReference>;

export function getEvalIaSurfaceReference(
  id: EvalIaSurfaceId,
): EvalIaSurfaceReference {
  return EVAL_IA_SURFACE_SEQUENCE.find((surface) => surface.id === id)!;
}
