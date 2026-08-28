import { WORKFLOW_STAGES, type StageSummary, type WorkflowStage } from '../interaction-model';

export type TeamRetouchStep = WorkflowStage;

type Props = {
  value: TeamRetouchStep;
  onChange: (step: TeamRetouchStep) => void;
  disabled?: boolean;
  summaries?: StageSummary[];
  onBlocked?: (reason: string) => void;
};

export const TeamRetouchSteps = ({ value, onChange, disabled = false, summaries }: Props) => {
  const byId = new Map((summaries || []).map(item => [item.id, item]));
  const progressIndex = WORKFLOW_STAGES.findIndex(step => !byId.get(step.id)?.complete);
  return (
  <nav aria-label="团片协作任务" data-stage-layout="tabs" role="tablist" className="team-stage-nav ml-3 grid h-full min-w-0 grid-cols-4 overflow-x-auto text-xs font-bold">
    {WORKFLOW_STAGES.map((step, stepIndex) => { const summary = byId.get(step.id); const selected = value === step.id; const complete = Boolean(summary?.complete); const progress = !complete && progressIndex === stepIndex; const locked = !complete && !progress && (Boolean(summary?.blockedReason) || progressIndex >= 0 && stepIndex > progressIndex); const tone = complete ? 'complete' : progress ? 'progress' : 'other'; return <button
      key={step.id}
      type="button"
      role="tab"
      disabled={disabled || locked}
      data-selected={selected || undefined}
      data-tone={tone}
      aria-disabled={locked || undefined}
      aria-selected={selected}
      aria-current={progress ? 'step' : undefined}
      title={summary?.blockedReason || step.completion}
      onClick={() => onChange(step.id)}
      className="team-stage-button relative inline-flex min-w-0 flex-1 items-center justify-start gap-1.5 px-4 text-left transition"
    >
      <span className="team-stage-index inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px]">{step.number}</span>
      <span className="team-stage-label truncate">{step.label}</span>
      {summary && <span className="team-stage-count whitespace-nowrap text-[10px] font-medium opacity-70">{summary.count}</span>}
    </button>; })}
  </nav>
  );
};

