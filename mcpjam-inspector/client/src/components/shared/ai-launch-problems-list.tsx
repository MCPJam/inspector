import {
  aiLaunchDependencyTitle,
  type AiLaunchProblem,
} from "@/lib/ai-launch-problems";

/**
 * Every required AI dependency a launch was refused for, one per line, so the
 * person sees the whole list at once. Rendered under the launch error.
 */
export function AiLaunchProblemsList({
  problems,
  className,
}: {
  problems: readonly AiLaunchProblem[];
  className?: string;
}) {
  if (problems.length === 0) return null;
  return (
    <ul
      className={className ?? "mt-1 list-disc space-y-0.5 pl-4 text-xs"}
      data-testid="ai-launch-problems"
      aria-label="What can't run on the organization's providers"
    >
      {problems.map((problem, index) => (
        <li
          key={`${problem.dependency}:${problem.label}:${problem.code}:${index}`}
        >
          <span className="font-medium">
            {aiLaunchDependencyTitle(problem.dependency)}
          </span>
          {": "}
          {problem.reason}
        </li>
      ))}
    </ul>
  );
}
