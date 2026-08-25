export type ToastStackGeometry = Pick<Element, 'querySelector' | 'getBoundingClientRect'>;

export const hostToastReservationBottom = (stack: ToastStackGeometry | null, gap = 12) => stack?.querySelector('[data-top-toast-id]')
  ? Math.max(0, Math.ceil(stack.getBoundingClientRect().bottom + gap))
  : 0;
