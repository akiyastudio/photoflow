import { WORKFLOW_STAGES, type StageSummary, type WorkflowStage } from '../interaction-model';

export type TeamRetouchStep = WorkflowStage;

type Props = {
  value: TeamRetouchStep;
  onChange: (step: TeamRetouchStep) => void;
  disabled?: boolean;
  summaries?: StageSummary[];
  onBlocked?: (reason: string) => void;
};

export const TeamRetouchSteps = ({ value, onChange, disabled = false, summaries, onBlocked }: Props) => {
  const byId = new Map((summaries || []).map(item => [item.id, item]));
  return (
  <nav aria-label="团片协作四阶段" data-stage-layout="responsive" className="team-stage-nav pf-surface ml-5 flex rounded-lg bg-slate-100 p-1 text-xs font-bold">
    {WORKFLOW_STAGES.map(step => { const summary = byId.get(step.id); const blocked = Boolean(summary?.blockedReason); return <button
      key={step.id}
      type="button"
      disabled={disabled}
      aria-disabled={blocked || undefined}
      aria-current={value === step.id ? 'step' : undefined}
      title={summary?.blockedReason || step.completion}
      onClick={() => blocked ? onBlocked?.(summary?.blockedReason || '') : onChange(step.id)}
      className={`team-stage-button pf-button inline-flex min-w-0 items-center gap-1.5 rounded-md px-3 py-2 transition disabled:opacity-50 ${value === step.id ? 'bg-white text-blue-600 shadow-sm' : summary?.complete ? 'text-emerald-700 hover:text-emerald-900' : blocked ? 'cursor-not-allowed text-slate-400' : 'text-slate-500 hover:text-slate-800'}`}
    >
      <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${value === step.id ? 'bg-blue-600 text-white' : summary?.complete ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{summary?.complete ? '✓' : step.number}</span>
      <span className="team-stage-label truncate">{step.label}</span>
      {summary && <span className="team-stage-count whitespace-nowrap text-[10px] font-medium opacity-70">{summary.count}</span>}
    </button>; })}
  </nav>
  );
};

