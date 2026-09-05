import { createContext, useContext } from 'react';

export type LegacyDialogTone = 'default' | 'danger';
export type LegacyDialogChoice = { value: string; label: string; tone?: LegacyDialogTone };
export type LegacyDialogOptions = { title: string; message: string; detail?: string; confirmLabel?: string; cancelLabel?: string; defaultValue?: string; cancelDefault?: boolean; dismissible?: boolean; tone?: LegacyDialogTone; choices?: LegacyDialogChoice[] };
export type LegacyDialogRequest = LegacyDialogOptions & { kind: 'confirm' | 'prompt' | 'choice' };
export type LegacyDialogApi = { confirm: (value: LegacyDialogOptions) => Promise<boolean>; prompt: (value: LegacyDialogOptions) => Promise<string | null>; choice: (value: LegacyDialogOptions) => Promise<string | null> };

export const LegacyDialogContext = createContext<LegacyDialogApi | null>(null);

export const useAppDialog = () => {
  const value = useContext(LegacyDialogContext);
  if (!value) throw new Error('LegacyDialogProvider is missing');
  return value;
};
