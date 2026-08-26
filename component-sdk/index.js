export const host = window.photoFlowComponent;

export const assertHostApiV2 = context => {
  if (!Number.isInteger(context?.hostApiVersion) || context.hostApiVersion < 2) {
    const error = new Error(`PhotoFlow Host API 2 or newer is required; negotiated ${context?.hostApiVersion || 'unknown'}`);
    error.code = 'COMPONENT_HOST_API_INCOMPATIBLE';
    throw error;
  }
};

export const assertHostApiV4 = context => {
  if (!Number.isInteger(context?.hostApiVersion) || context.hostApiVersion < 4 || typeof window.photoFlowComponent?.notify !== 'function') {
    const error = new Error(`PhotoFlow Host API 4 notifications are required; negotiated ${context?.hostApiVersion || 'unknown'}`);
    error.code = 'COMPONENT_HOST_API_INCOMPATIBLE';
    throw error;
  }
};

export const assertHostApiV5 = context => {
  if (!Number.isInteger(context?.hostApiVersion) || context.hostApiVersion < 5) {
    const error = new Error(`PhotoFlow Host API 5 project read extensions are required; negotiated ${context?.hostApiVersion || 'unknown'}`);
    error.code = 'COMPONENT_HOST_API_UNSUPPORTED';
    throw error;
  }
};

export const assertHostApiV6 = context => {
  if (!Number.isInteger(context?.hostApiVersion) || context.hostApiVersion < 6) {
    const error = new Error(`PhotoFlow Host API 6 project write extensions are required; negotiated ${context?.hostApiVersion || 'unknown'}`);
    error.code = 'COMPONENT_HOST_API_UNSUPPORTED';
    throw error;
  }
};
export const assertHostApiV7 = context => { if (!Number.isInteger(context?.hostApiVersion) || context.hostApiVersion < 7) { const error = new Error(`PhotoFlow Host API 7 is required; negotiated ${context?.hostApiVersion || 'unknown'}`); error.code = 'COMPONENT_HOST_API_UNSUPPORTED'; throw error; } };
