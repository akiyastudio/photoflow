const { registerComponentProjectCapabilities } = require('./component-project-capabilities.cjs');
const { ComponentCapabilityBroker } = require('./component-capability-broker.cjs');
const { ComponentNotificationService } = require('./component-notification-service.cjs');
const { registerComponentProjectReadCapabilities } = require('./component-project-read-capabilities.cjs');
const { registerComponentProjectWriteCapabilities } = require('./component-project-write-capabilities.cjs');
const { createComponentSecretsService } = require('./component-secrets-service.cjs');
const { createComponentNetworkService } = require('./component-network-service.cjs');
const { createComponentRuntimeExecutionService } = require('./component-runtime-execution-service.cjs');
const { translateLegacyMediaProcess } = require('../compatibility/legacy-media-process-v7.cjs');

const createComponentHostCapabilityRuntime = dependencies => {
  const componentCapabilityBroker = new ComponentCapabilityBroker();
  const componentNotificationService = new ComponentNotificationService({ mainWindow: dependencies.mainWindow });
  componentCapabilityBroker.register('notifications', (payload, context, descriptor) => componentNotificationService.publish(descriptor, payload, context));
  const projectDomain = registerComponentProjectCapabilities({ ...dependencies, broker: componentCapabilityBroker });
  registerComponentProjectReadCapabilities({ ...dependencies, broker: componentCapabilityBroker });
  const runtimeExecution = createComponentRuntimeExecutionService({ ...dependencies, broker: componentCapabilityBroker, inputTokens: projectDomain });
  const legacyMediaProcess = (payload, context, descriptor) => { const translated = translateLegacyMediaProcess(payload, descriptor); return translated ? runtimeExecution.invoke(translated, context, descriptor, { compatibility: true }) : null; };
  const writeDomain = registerComponentProjectWriteCapabilities({ ...dependencies, broker: componentCapabilityBroker, projectDomain, legacyMediaProcess });
  const secretsService = createComponentSecretsService(dependencies); const networkService = createComponentNetworkService({ ...dependencies, secretsService });
  componentCapabilityBroker.register('component.secrets', secretsService.invoke);
  componentCapabilityBroker.register('network.fetch', networkService.invoke);
  const clearComponentCapabilityState = async componentId => { const results=await Promise.allSettled([projectDomain?.clearComponent?.(componentId),runtimeExecution?.clearComponent?.(componentId),writeDomain?.clearComponent?.(componentId)]);const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);if(errors.length)throw new AggregateError(errors,`Unable to clear every capability state for ${componentId}`); };
  return { componentCapabilityBroker, componentInputGrants: projectDomain, componentNotificationService, clearComponentCapabilityState, clearComponentSecretData: secretsService.removeComponentData, abortComponentNetworkRequests: networkService.clearComponent };
};

module.exports = { createComponentHostCapabilityRuntime };
