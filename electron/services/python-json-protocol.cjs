const parsePythonJsonMessages = output => String(output || '')
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean)
  .flatMap(line => {
    try { return [JSON.parse(line)]; }
    catch { return []; }
  });

const findPythonJsonFailureMessage = messages => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if ((message?.type === 'error' || message?.type === 'cancelled') && String(message.message || '').trim()) {
      return String(message.message).trim();
    }
  }
  return '';
};

module.exports = { findPythonJsonFailureMessage, parsePythonJsonMessages };
