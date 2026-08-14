type Props = {
  value: number;
  minimumVisible?: number;
  trackClassName: string;
  barClassName: string;
};

export const ProgressBar = ({ value, minimumVisible = 0, trackClassName, barClassName }: Props) => {
  const normalized = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
  const percentage = normalized > 0 ? Math.max(minimumVisible, normalized) : 0;
  return <div className={trackClassName}><div className={barClassName} style={{ width: `${percentage}%` }}/></div>;
};
