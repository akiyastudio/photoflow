import type { StageSummary } from '../interaction-model';
import { TeamRetouchBrand } from './TeamRetouchBrand';
import { TeamRetouchSteps, type TeamRetouchStep } from './TeamRetouchSteps';

type Props = {
  activeStep: TeamRetouchStep;
  onStepChange: (step: TeamRetouchStep) => void;
  stageSummaries?: StageSummary[];
  onBlockedStage?: (reason: string) => void;
  disabled?: boolean;
};

export const TeamWorkflowHeader = ({ activeStep, onStepChange, stageSummaries, onBlockedStage, disabled = false }: Props) => (
  <header className="team-workflow-header team-toolbar pf-toolbar flex h-12 shrink-0 items-center border-b border-slate-200 bg-white px-4">
    <TeamRetouchBrand/>
    <TeamRetouchSteps value={activeStep} onChange={onStepChange} summaries={stageSummaries} onBlocked={onBlockedStage} disabled={disabled}/>
  </header>
);
