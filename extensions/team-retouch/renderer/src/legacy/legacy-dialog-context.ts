import { createContext, useContext } from 'react';

export type LegacyDialogChoice = { value: string; label: string };
export type LegacyDialogRequest = { kind: 'confirm' | 'prompt' | 'choice'; title: string; message: string; detail?: string; confirmLabel?: string; cancelLabel?: string; defaultValue?: string; tone?: string; choices?: LegacyDialogChoice[]; resolve: (value: any) => void };
export type LegacyDialogOptions = Omit<LegacyDialogRequest, 'kind' | 'resolve'>;
export type LegacyDialogApi = { confirm: (value: LegacyDialogOptions) => Promise<boolean>; prompt: (value: LegacyDialogOptions) => Promise<string | null>; choice: (value: LegacyDialogOptions) => Promise<string | null> };

export const LegacyDialogContext = createContext<LegacyDialogApi | null>(null);

export const useAppDialog = () => {
  const value = useContext(LegacyDialogContext);
  if (!value) throw new Error('LegacyDialogProvider is missing');
  return value;
};
