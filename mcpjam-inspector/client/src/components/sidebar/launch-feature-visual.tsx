import swarmImage from "@/assets/platform-launch/swarms.png";
import userTestingImage from "@/assets/platform-launch/user-testing.png";
import evalsImage from "@/assets/platform-launch/evals.png";
import cicdImage from "@/assets/platform-launch/ci-cd.png";

const VISUALS = {
  swarms: {
    src: swarmImage,
    alt: "Swarm insights showing user goals, behavior, outcomes, and sentiment",
  },
  "user-testing": {
    src: userTestingImage,
    alt: "User testing findings with tester feedback and root causes",
  },
  evals: {
    src: evalsImage,
    alt: "Evaluate dashboard with suite health and cross-client run results",
  },
  "ci-cd": {
    src: cicdImage,
    alt: "MCPJam release checks and readiness across clients",
  },
};
export type LaunchFeatureId = keyof typeof VISUALS;
export function LaunchFeatureVisual({ feature }: { feature: LaunchFeatureId }) {
  return (
    <img
      {...VISUALS[feature]}
      className="aspect-video w-full rounded-lg border border-border bg-muted object-contain"
    />
  );
}
