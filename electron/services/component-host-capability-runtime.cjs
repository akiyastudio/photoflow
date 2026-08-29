const { registerComponentProjectCapabilities } = require('./component-project-capabilities.cjs');
const { ComponentCapabilityBroker } = require('./component-capability-broker.cjs');
const { ComponentNotificationService } = require('./component-notification-service.cjs');
const { registerComponentProjectReadCapabilities } = require('./component-project-read-capabilities.cjs');
const { registerComponentProjectWriteCapabilities } = require('./component-project-write-capabilities.cjs');
const { createComponentSecretsService } = require('./component-secrets-service.cjs');
const { createComponentNetworkService } = require('./component-network-service.cjs');

const createComponentHostCapabilityRuntime = dependencies => {
  const componentCapabilityBroker = new ComponentCapabilityBroker();
  const componentNotificationService = new ComponentNotificationService({ mainWindow: dependencies.mainWindow });
  componentCapabilityBroker.register('notifications.v7', (payload, context, descriptor) => componentNotificationService.publish(descriptor, payload, context));
  const projectDomain = registerComponentProjectCapabilities({ ...dependencies, broker: componentCapabilityBroker });
  registerComponentProjectReadCapabilities({ ...dependencies, broker: componentCapabilityBroker });
  const writeDomain = registerComponentProjectWriteCapabilities({ ...dependencies, broker: componentCapabilityBroker, projectDomain });
  const secretsService = createComponentSecretsService(dependencies); const networkService = createComponentNetworkService({ ...dependencies, secretsService });
  componentCapabilityBroker.register('component.secrets.v7', secretsService.invoke);
  componentCapabilityBroker.register('network.fetch.v7', networkService.invoke);
  const clearComponentCapabilityState = componentId => { projectDomain?.clearComponent?.(componentId); writeDomain?.clearComponent?.(componentId); };
  return { componentCapabilityBroker, componentInputGrants: projectDomain, componentNotificationService, clearComponentCapabilityState, clearComponentSecretData: secretsService.removeComponentData, abortComponentNetworkRequests: networkService.clearComponent };
};

module.exports = { createComponentHostCapabilityRuntime };
