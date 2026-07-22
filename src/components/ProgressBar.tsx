type Props = {
  value: number;
  minimumVisible?: number;
  trackClassName: string;
  barClassName: string;
};

export const ProgressBar = ({ value, minimumVisible = 0, trackClassName, barClassName }: Props) => {
  const percentage = Math.max(minimumVisible, Math.min(100, Math.max(0, value)));
  return <div className={trackClassName}><div className={barClassName} style={{ width: `${percentage}%` }}/></div>;
};
