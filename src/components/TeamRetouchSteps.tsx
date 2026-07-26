export type TeamRetouchStep = 'detect' | 'people' | 'workflow';

type Props = {
  value: TeamRetouchStep;
  onChange: (step: TeamRetouchStep) => void;
  disabled?: boolean;
};

const steps: Array<{ id: TeamRetouchStep; number: number; label: string }> = [
  { id: 'detect', number: 1, label: '人物识别与标记' },
  { id: 'workflow', number: 2, label: '任务编排与返图' },
];

export const TeamRetouchSteps = ({ value, onChange, disabled = false }: Props) => {
  const visibleValue = value === 'people' ? 'detect' : value;
  return (
  <nav aria-label="团片协作处理步骤" className="ml-5 flex rounded-lg bg-slate-100 p-1 text-xs font-bold">
    {steps.map(step => <button
      key={step.id}
      type="button"
      disabled={disabled}
      aria-current={visibleValue === step.id ? 'step' : undefined}
      onClick={() => onChange(step.id)}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-2 transition disabled:opacity-50 ${visibleValue === step.id ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
    >
      <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${visibleValue === step.id ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{step.number}</span>
      {step.label}
    </button>)}
  </nav>
  );
};
