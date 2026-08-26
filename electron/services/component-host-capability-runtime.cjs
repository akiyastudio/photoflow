const { registerComponentProjectCapabilities } = require('./component-project-capabilities.cjs');
const { ComponentCapabilityBroker } = require('./component-capability-broker.cjs');
const { ComponentNotificationService } = require('./component-notification-service.cjs');
const { registerComponentProjectReadCapabilities } = require('./component-project-read-capabilities.cjs');

const createComponentHostCapabilityRuntime = dependencies => {
  const componentCapabilityBroker = new ComponentCapabilityBroker();
  const componentNotificationService = new ComponentNotificationService({ mainWindow: dependencies.mainWindow });
  componentCapabilityBroker.register('notifications.v2', (payload, context, descriptor) => componentNotificationService.publish(descriptor, payload, context));
  registerComponentProjectCapabilities({ ...dependencies, broker: componentCapabilityBroker });
  registerComponentProjectReadCapabilities({ ...dependencies, broker: componentCapabilityBroker });
  return { componentCapabilityBroker, componentNotificationService };
};

module.exports = { createComponentHostCapabilityRuntime };
