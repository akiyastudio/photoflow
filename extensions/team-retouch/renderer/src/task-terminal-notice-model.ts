export type TaskPresentation = 'visible' | 'silent' | 'none';
export type TerminalOutcome = 'completed' | 'failed' | 'cancelled';

export const terminalFeedbackOwner = ({ presentation }: { presentation: TaskPresentation; outcome: TerminalOutcome }) =>
  presentation === 'visible' ? 'task' as const : 'toast' as const;

export const shouldEmitTerminalToast = (value: { presentation: TaskPresentation; outcome: TerminalOutcome }) => terminalFeedbackOwner(value) === 'toast';
