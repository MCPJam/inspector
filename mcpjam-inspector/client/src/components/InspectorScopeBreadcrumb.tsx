import type { ReactNode } from "react";
import { ChevronDown, Folder } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@mcpjam/design-system/breadcrumb";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";

const pageNames = { events: "Events", "oauth-flow": "OAuth Debugger" };

interface InspectorScopeBreadcrumbProps {
  page: keyof typeof pageNames;
  activeProjectId: string;
  projects: readonly { id: string; name: string }[];
  onSwitchProject: (projectId: string) => void;
  serverPicker: ReactNode;
}

export function InspectorScopeBreadcrumb({
  page,
  activeProjectId,
  projects,
  onSwitchProject,
  serverPicker,
}: InspectorScopeBreadcrumbProps) {
  const projectName = projects.find(({ id }) => id === activeProjectId)?.name;

  return (
    <Breadcrumb aria-label="Inspector context" className="min-w-0">
      <BreadcrumbList className="flex-nowrap gap-1.5 sm:gap-2">
        <BreadcrumbItem className="min-w-0 basis-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="chrome"
                size="sm"
                disabled={!projects.length}
                aria-label={projectName ? `Switch project: ${projectName}` : "Choose project"}
                className="max-w-full min-w-0 gap-1.5"
              >
                <Folder className="max-sm:hidden" aria-hidden />
                <span className="max-w-40 truncate">{projectName ?? "Project"}</span>
                <ChevronDown className="size-3" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56" aria-label="Projects">
              <DropdownMenuRadioGroup
                value={activeProjectId}
                onValueChange={onSwitchProject}
              >
                {projects.map(({ id, name }) => (
                  <DropdownMenuRadioItem key={id} value={id}>
                    <span className="truncate">{name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="shrink-0">/</BreadcrumbSeparator>
        <BreadcrumbItem className="shrink-0 whitespace-nowrap font-medium text-foreground">
          <span aria-current="page">{pageNames[page]}</span>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="shrink-0">/</BreadcrumbSeparator>
        <BreadcrumbItem className="min-w-0">{serverPicker}</BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
