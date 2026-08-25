export const host = window.photoFlowComponent;

export const assertHostApiV2 = context => {
  if (!Number.isInteger(context?.hostApiVersion) || context.hostApiVersion < 2) {
    const error = new Error(`PhotoFlow Host API 2 or newer is required; negotiated ${context?.hostApiVersion || 'unknown'}`);
    error.code = 'COMPONENT_HOST_API_INCOMPATIBLE';
    throw error;
  }
};
