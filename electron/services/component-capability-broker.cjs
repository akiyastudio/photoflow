const { HOST_CAPABILITIES } = require('../component-host-contract.cjs');

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

const clonePayload = payload => {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Component capability payload must be an object');
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_PAYLOAD_BYTES) throw new RangeError('Component capability payload is too large');
  return JSON.parse(serialized);
};

class ComponentCapabilityBroker {
  constructor() { this.handlers = new Map(); }

  register(method, handler) {
    if (!HOST_CAPABILITIES.has(method)) throw new Error(`Unknown host capability: ${method}`);
    if (typeof handler !== 'function') throw new TypeError(`Host capability handler is required: ${method}`);
    if (this.handlers.has(method)) throw new Error(`Duplicate host capability: ${method}`);
    this.handlers.set(method, handler);
  }

  invoke(descriptor, method, payload, boundContext) {
    const normalized = String(method || '');
    if (!descriptor?.service?.capabilities.includes(normalized)) throw new Error(`Component capability is not granted: ${normalized}`);
    const handler = this.handlers.get(normalized);
    if (!handler) throw new Error(`Host capability is unavailable: ${normalized}`);
    return handler(clonePayload(payload), boundContext, descriptor);
  }
}

module.exports = { ComponentCapabilityBroker, MAX_PAYLOAD_BYTES, clonePayload };
