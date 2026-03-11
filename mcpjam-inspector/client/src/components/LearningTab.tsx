import { GraduationCap } from "lucide-react";
import { EmptyState } from "./ui/empty-state";

export function LearningTab() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <EmptyState
        icon={GraduationCap}
        title="Learning"
        description="Learning resources are coming soon. Stay tuned!"
      />
    </div>
  );
}
