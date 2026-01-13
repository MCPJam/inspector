import { ResolvedMatch, Team, TeamId } from "@shared/types";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet";

interface MatchDetailsSheetProps {
  open: boolean;
  match: ResolvedMatch | null;
  teamsById: Record<TeamId, Team>;
  onOpenChange: (open: boolean) => void;
}

const MatchDetailsSheet = ({ open, match, teamsById, onOpenChange }: MatchDetailsSheetProps) => {
  const lookup = (teamId?: string) => (teamId ? teamsById[teamId]?.name ?? teamId : "TBD");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        {match ? (
          <div className="space-y-4">
            <SheetHeader>
              <SheetTitle>
                {lookup(match.homeTeamId)} vs {lookup(match.awayTeamId)}
              </SheetTitle>
              <SheetDescription>{match.id}</SheetDescription>
            </SheetHeader>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Round</span>
                <span>{match.round}</span>
              </div>
              {match.metadata?.date && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Date</span>
                  <span>{match.metadata.date}</span>
                </div>
              )}
              {match.metadata?.city && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">City</span>
                  <span>{match.metadata.city}</span>
                </div>
              )}
              {match.metadata?.stadium && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Stadium</span>
                  <span>{match.metadata.stadium}</span>
                </div>
              )}
              {match.metadata?.fifaUrl && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Link</span>
                  <a
                    className="text-primary underline"
                    href={match.metadata.fifaUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    FIFA preview
                  </a>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Select a match to view details.</div>
        )}
      </SheetContent>
    </Sheet>
  );
};

export default MatchDetailsSheet;










