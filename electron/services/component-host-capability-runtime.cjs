const { registerDeprecatedComponentHostV1Capabilities } = require('../compatibility/component-host-v1.cjs');
const { registerComponentProjectCapabilities } = require('./component-project-capabilities.cjs');
const { ComponentCapabilityBroker } = require('./component-capability-broker.cjs');
const { ComponentNotificationService } = require('./component-notification-service.cjs');

const createComponentHostCapabilityRuntime = dependencies => {
  const componentCapabilityBroker = new ComponentCapabilityBroker();
  const componentNotificationService = new ComponentNotificationService({ mainWindow: dependencies.mainWindow });
  componentCapabilityBroker.register('notifications.v2', (payload, context, descriptor) => componentNotificationService.publish(descriptor, payload, context));
  registerComponentProjectCapabilities({ ...dependencies, broker: componentCapabilityBroker });
  registerDeprecatedComponentHostV1Capabilities({ ...dependencies, broker: componentCapabilityBroker });
  return { componentCapabilityBroker, componentNotificationService };
};

module.exports = { createComponentHostCapabilityRuntime };
