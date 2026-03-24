import { ChevronRight } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  LEARNING_CONCEPTS,
  type LearningConcept,
} from "@/components/lifecycle/learning-concepts";

interface LearningLandingPageProps {
  onSelect: (conceptId: string) => void;
}

function ConceptCard({
  concept,
  onSelect,
}: {
  concept: LearningConcept;
  onSelect: (id: string) => void;
}) {
  const Icon = concept.icon;

  return (
    <Card
      className="cursor-pointer transition-shadow hover:shadow-md"
      onClick={() => onSelect(concept.id)}
    >
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Icon className="h-4.5 w-4.5 text-muted-foreground" />
            </div>
            <div>
              <CardTitle className="text-sm">{concept.title}</CardTitle>
            </div>
          </div>
          <Badge variant="secondary" className="text-[10px]">
            {concept.category}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <CardDescription className="mb-3 text-xs">
          {concept.description}
        </CardDescription>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">
            {concept.totalSteps} steps
          </span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      </CardContent>
    </Card>
  );
}

export function LearningLandingPage({ onSelect }: LearningLandingPageProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Learning</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Interactive walkthroughs to learn MCP concepts
        </p>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {LEARNING_CONCEPTS.map((concept) => (
            <ConceptCard
              key={concept.id}
              concept={concept}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
