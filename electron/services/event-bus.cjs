const { EventEmitter } = require('events');

const createEventBus = () => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  return {
    emit: (eventName, payload) => emitter.emit(eventName, payload),
    on: (eventName, listener) => {
      emitter.on(eventName, listener);
      return () => emitter.off(eventName, listener);
    },
    once: (eventName, listener) => emitter.once(eventName, listener),
    clear: () => emitter.removeAllListeners(),
  };
};

module.exports = { createEventBus };
