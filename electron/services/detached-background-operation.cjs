const startDetachedBackgroundOperation = ({ operationId, worker, onUnexpectedError = () => undefined }) => {
  Promise.resolve()
    .then(worker)
    .catch(onUnexpectedError);
  return { success: true, started: true, operationId };
};

module.exports = { startDetachedBackgroundOperation };
