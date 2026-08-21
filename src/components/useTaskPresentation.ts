import { usePanelTaskIdentity } from '../features/background-tasks/TaskCenter';

/** Gives task producers the optional panel destination without exposing task-center internals. */
export const useTaskPresentation = usePanelTaskIdentity;
