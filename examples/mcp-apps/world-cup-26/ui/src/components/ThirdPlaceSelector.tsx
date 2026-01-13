import { GroupPrediction, Team, TeamId, ThirdPlaceSelection } from "@shared/types";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { ArrowUp, ArrowDown, X } from "lucide-react";

interface ThirdPlaceSelectorProps {
  groups: GroupPrediction[];
  teamsById: Record<TeamId, Team>;
  selection: ThirdPlaceSelection;
  onChange: (next: ThirdPlaceSelection) => void;
  onContinue: () => void;
  onBack: () => void;
}

const ThirdPlaceSelector = ({
  groups,
  teamsById,
  selection,
  onChange,
  onContinue,
  onBack,
}: ThirdPlaceSelectorProps) => {
  const thirdPlaceTeams = groups
    .map((g) => teamsById[g.positions[3]])
    .filter(Boolean) as Team[];

  const selectedIds = selection.advancingThirdPlaceTeamIds;
  const selectedCount = selectedIds.length;
  const ready = selectedCount === 8;

  const toggle = (teamId: TeamId) => {
    const currentIndex = selectedIds.indexOf(teamId);
    if (currentIndex !== -1) {
      // Remove from selection
      onChange({ advancingThirdPlaceTeamIds: selectedIds.filter((id) => id !== teamId) });
    } else if (selectedCount < 8) {
      // Add to end (lowest rank)
      onChange({ advancingThirdPlaceTeamIds: [...selectedIds, teamId] });
    }
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const newIds = [...selectedIds];
    [newIds[index - 1], newIds[index]] = [newIds[index], newIds[index - 1]];
    onChange({ advancingThirdPlaceTeamIds: newIds });
  };

  const moveDown = (index: number) => {
    if (index === selectedIds.length - 1) return;
    const newIds = [...selectedIds];
    [newIds[index], newIds[index + 1]] = [newIds[index + 1], newIds[index]];
    onChange({ advancingThirdPlaceTeamIds: newIds });
  };

  const remove = (index: number) => {
    onChange({ advancingThirdPlaceTeamIds: selectedIds.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-6">
      <div className="text-center space-y-1">
        <h2 className="text-xl sm:text-2xl font-display font-semibold trophy-shimmer">
          Best Third-Place Teams
        </h2>
        <p className="text-muted-foreground text-sm">
          Select <span className="text-gold font-medium">8 of 12</span> teams in ranking order • {selectedCount}/8 selected
        </p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          ⚠️ Order matters! First selected = highest rank, last = lowest rank
        </p>
      </div>

      {/* Selected teams in order (ranked) */}
      {selectedIds.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-gold/80">Selected Teams (Ranked 1-{selectedIds.length})</h3>
          <div className="space-y-2">
            {selectedIds.map((teamId, index) => {
              const team = teamsById[teamId];
              if (!team) return null;
              return (
                <Card
                  key={`selected-${teamId}-${index}`}
                  className="glass-card bg-white/8 border-gold/40"
                >
                  <CardContent className="p-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-r from-gold-dark to-gold text-fifa-blue flex items-center justify-center font-bold text-sm">
                        {index + 1}
                      </div>
                      <div className="flex-1 flex items-center gap-2">
                        <span className="text-xl">{team.flagEmoji}</span>
                        <span className="font-medium text-gold">{team.name}</span>
                        <span className="text-xs text-muted-foreground">({team.confederation ?? "N/A"})</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => moveUp(index)}
                          disabled={index === 0}
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => moveDown(index)}
                          disabled={index === selectedIds.length - 1}
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-red-400 hover:text-red-300"
                          onClick={() => remove(index)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Available teams to select */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground/70">
          Available Teams ({thirdPlaceTeams.length - selectedIds.length} remaining)
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {thirdPlaceTeams
            .filter((team) => !selectedIds.includes(team.id))
            .map((team, idx) => {
              return (
                <Card
                  key={team.id}
                  className="glass-card bg-white/5 border-white/10 cursor-pointer transition-all animate-fade-in hover:bg-white/10"
                  style={{ animationDelay: `${idx * 0.03}s` }}
                  onClick={() => toggle(team.id)}
                >
                  <CardHeader className="flex flex-row items-center justify-between space-y-0">
                    <CardTitle className="text-base flex items-center gap-2">
                      <span className="text-xl">{team.flagEmoji}</span>
                      <span>{team.name}</span>
                    </CardTitle>
                    <Checkbox 
                      checked={false} 
                      onCheckedChange={() => toggle(team.id)} 
                      className="border-white/30"
                      disabled={selectedCount >= 8}
                    />
                  </CardHeader>
                  <CardContent>
                    <CardDescription className="text-muted-foreground">
                      {team.confederation ?? "N/A"}
                    </CardDescription>
                  </CardContent>
                </Card>
              );
            })}
        </div>
      </div>

      {/* Navigation at bottom */}
      <div className="flex justify-center gap-3 pt-4">
        <Button variant="outline" onClick={onBack} className="border-white/20 hover:bg-white/10">
          ← Back
        </Button>
        <Button 
          disabled={!ready} 
          onClick={onContinue} 
          className={ready ? "bg-gradient-to-r from-gold-dark via-gold to-gold-light text-fifa-blue font-semibold shadow-lg shadow-gold/25" : ""}
        >
          Continue →
        </Button>
      </div>
    </div>
  );
};

export default ThirdPlaceSelector;

