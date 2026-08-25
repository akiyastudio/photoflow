export type ToastStackGeometry = Pick<Element, 'querySelector' | 'getBoundingClientRect'>;

export const hostToastReservationBottom = (stack: ToastStackGeometry | null, gap = 12, viewportHeight = Number.POSITIVE_INFINITY, minimumSurfaceHeight = 120) => stack?.querySelector('[data-top-toast-id]')
  ? Math.max(0, Math.min(Math.ceil(stack.getBoundingClientRect().bottom + gap), Math.max(0, Math.floor(viewportHeight - minimumSurfaceHeight))))
  : 0;
