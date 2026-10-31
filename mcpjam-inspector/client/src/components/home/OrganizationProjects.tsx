import { Button } from "@mcpjam/design-system/button";
import { buildProjectSwitchTarget, useAppNavigate } from "@/lib/app-navigation";

export function OrganizationProjects({
  projects,
}: {
  projects: { _id: string; name: string }[] | undefined;
}) {
  const navigate = useAppNavigate();
  if (!projects?.length) return null;
  return (
    <section className="space-y-2" aria-labelledby="home-projects-heading">
      <h2 id="home-projects-heading" className="text-lg font-medium">
        Your projects
      </h2>
      {projects.map((project) => (
        <div
          key={project._id}
          className="flex items-center justify-between gap-4 border-b border-border py-4"
        >
          <p className="min-w-0 truncate text-sm font-medium">{project.name}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(buildProjectSwitchTarget(project._id))}
          >
            Open project
          </Button>
        </div>
      ))}
    </section>
  );
}
