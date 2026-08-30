export const host = window.photoFlowComponent;

export const uiContractVersion = 1;

export const applyUiTheme = (resolvedTheme, root = document.documentElement) => {
  const dark = resolvedTheme === 'dark';
  root.classList.toggle('dark', dark);
  root.dataset.photoflowTheme = dark ? 'dark' : 'light';
  return dark ? 'dark' : 'light';
};

export const mountUiTheme = async (root = document.documentElement) => {
  const context = await host.getContext();
  if (context.uiContractVersion !== uiContractVersion) throw new Error(`PhotoFlow UI contract ${uiContractVersion} is required; negotiated ${context.uiContractVersion || 'unknown'}`);
  applyUiTheme(context.resolvedTheme, root);
  return host.onThemeChange(value => applyUiTheme(value.resolvedTheme, root));
};

export const assertHostApi = context => { if (context?.hostApiVersion !== 7) { const error = new Error(`PhotoFlow Host API is required; negotiated ${context?.hostApiVersion || 'unknown'}`); error.code = 'COMPONENT_HOST_API_UNSUPPORTED'; throw error; } };
