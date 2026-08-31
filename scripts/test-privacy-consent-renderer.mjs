import assert from 'node:assert/strict';

let choiceCalls = 0;
let saveCalls = 0;
let releaseChoice;
const choiceGate = new Promise(resolve => { releaseChoice = resolve; });
globalThis.window = {
  electronAPI: {
    apiContractVersion: 1,
    getPrivacyConsentState: async () => ({ faceRecognitionGranted: false }),
    savePrivacyConsent: async () => { saveCalls += 1; return { success: true, state: { faceRecognitionGranted: true } }; },
    openLegalDocument: async () => ({ success: true }),
  },
};

const { ensureFaceRecognitionConsent } = await import('../src/utils/privacyConsent.ts');
const dialog = { choice: async () => { choiceCalls += 1; return choiceGate; } };
const first = ensureFaceRecognitionConsent(dialog);
const second = ensureFaceRecognitionConsent(dialog);
assert.strictEqual(first, second, 'concurrent callers share one consent request');
releaseChoice('agree');
assert.equal(await first, true); assert.equal(await second, true);
assert.equal(choiceCalls, 1); assert.equal(saveCalls, 1, 'one dialog produces one consent write');

window.electronAPI.openLegalDocument = async () => ({ success: false, error: 'missing rules' });
const rulesResult = await ensureFaceRecognitionConsent({ choice: async () => 'rules' });
assert.equal(rulesResult, false, 'failure to open the rules stops consent instead of looping');
assert.equal(saveCalls, 1);

window.electronAPI.savePrivacyConsent = async () => { throw new Error('offline'); };
assert.equal(await ensureFaceRecognitionConsent({ choice: async () => 'agree' }), false, 'a rejected consent save remains retryable');

console.log('Renderer privacy consent concurrency tests passed');
