export const host = window.photoFlowComponent;

export const assertHostApiV2 = context => {
  if (context?.hostApiVersion !== 2) {
    const error = new Error(`PhotoFlow Host API 2 is required; negotiated ${context?.hostApiVersion || 'unknown'}`);
    error.code = 'COMPONENT_HOST_API_INCOMPATIBLE';
    throw error;
  }
};
