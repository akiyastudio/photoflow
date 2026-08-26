export const host = window.photoFlowComponent;

export const assertHostApiV7 = context => { if (context?.hostApiVersion !== 7) { const error = new Error(`PhotoFlow Host API 7 is required; negotiated ${context?.hostApiVersion || 'unknown'}`); error.code = 'COMPONENT_HOST_API_UNSUPPORTED'; throw error; } };
