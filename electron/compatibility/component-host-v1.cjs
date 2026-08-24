/**
 * @deprecated Aggregate for installed Component Host V1 packages.
 *
 * The composition root depends only on this protocol-level seam. Business
 * adapters stay private to this directory and must not be extended for V2.
 */
const { registerDeprecatedTeamRetouchV1Capabilities } = require('./component-team-retouch-v1-adapter.cjs');
const { registerDeprecatedTeamRetouchRpc } = require('./component-team-retouch-rpc-v1.cjs');

const registerDeprecatedComponentHostV1Capabilities = options => {
  registerDeprecatedTeamRetouchV1Capabilities(options);
};

const COMPONENT_HOST_V1_RPC_REGISTRARS = Object.freeze([registerDeprecatedTeamRetouchRpc]);

module.exports = { COMPONENT_HOST_V1_RPC_REGISTRARS, registerDeprecatedComponentHostV1Capabilities };
