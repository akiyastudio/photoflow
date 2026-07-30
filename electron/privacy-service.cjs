const CURRENT_PRIVACY_NOTICE_VERSION = '2026-07-29';
const CURRENT_TERMS_VERSION = '2026-07-29';
const CURRENT_FACE_RULES_VERSION = '2026-07-29';

const LEGAL_DOCUMENTS = Object.freeze({
  privacy: 'PRIVACY_POLICY.md',
  terms: 'USER_AGREEMENT.md',
  face: 'FACE_RECOGNITION_RULES.md',
  'information-list': 'PERSONAL_INFORMATION_LIST.md',
  'third-parties': 'THIRD_PARTY_SERVICES.md',
  permissions: 'PERMISSIONS.md',
  children: 'CHILDREN_PRIVACY.md',
  'customer-data': 'CUSTOMER_DATA_PROCESSING_TERMS.md',
  'open-source': 'OPEN_SOURCE_NOTICES.md',
});

const createPrivacyService = ({ app, fs, path, shell, projectRoot }) => {
  const statePath = path.join(app.getPath('userData'), 'privacy-consent.json');
  const legalRoot = () => app.isPackaged
    ? path.join(process.resourcesPath, 'legal')
    : path.join(projectRoot, 'docs', 'legal');

  const readState = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const publicState = () => {
    const state = readState();
    return {
      privacyNoticeVersion: String(state.privacyNoticeVersion || ''),
      privacyNoticeAcceptedAt: String(state.privacyNoticeAcceptedAt || ''),
      termsVersion: String(state.termsVersion || ''),
      termsAcceptedAt: String(state.termsAcceptedAt || ''),
      faceRulesVersion: String(state.faceRulesVersion || ''),
      faceRecognitionGrantedAt: String(state.faceRecognitionGrantedAt || ''),
      faceRecognitionGranted: state.faceRecognitionGranted === true
        && state.faceRulesVersion === CURRENT_FACE_RULES_VERSION,
      currentPrivacyNoticeVersion: CURRENT_PRIVACY_NOTICE_VERSION,
      currentTermsVersion: CURRENT_TERMS_VERSION,
      currentFaceRulesVersion: CURRENT_FACE_RULES_VERSION,
    };
  };

  const hasCoreConsent = () => {
    const state = readState();
    return state.privacyNoticeVersion === CURRENT_PRIVACY_NOTICE_VERSION
      && state.termsVersion === CURRENT_TERMS_VERSION;
  };

  const hasFaceRecognitionConsent = () => {
    const state = readState();
    return state.faceRecognitionGranted === true
      && state.faceRulesVersion === CURRENT_FACE_RULES_VERSION;
  };

  const saveConsent = async request => {
    const state = readState();
    const now = new Date().toISOString();
    if (request?.revokeCore === true) {
      state.privacyNoticeVersion = '';
      state.privacyNoticeAcceptedAt = '';
      state.termsVersion = '';
      state.termsAcceptedAt = '';
    }
    if (request?.acceptCore === true) {
      state.privacyNoticeVersion = CURRENT_PRIVACY_NOTICE_VERSION;
      state.privacyNoticeAcceptedAt = now;
      state.termsVersion = CURRENT_TERMS_VERSION;
      state.termsAcceptedAt = now;
    }
    if (typeof request?.faceRecognitionGranted === 'boolean') {
      state.faceRecognitionGranted = request.faceRecognitionGranted;
      state.faceRulesVersion = request.faceRecognitionGranted ? CURRENT_FACE_RULES_VERSION : '';
      state.faceRecognitionGrantedAt = request.faceRecognitionGranted ? now : '';
    }
    await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
    return publicState();
  };

  const openLegalDocument = async documentId => {
    const fileName = LEGAL_DOCUMENTS[String(documentId || '')];
    if (!fileName) return { success: false, error: '未知的法律文件' };
    const filePath = path.join(legalRoot(), fileName);
    if (!fs.existsSync(filePath)) return { success: false, error: `法律文件不存在：${fileName}` };
    const error = await shell.openPath(filePath);
    return error ? { success: false, error } : { success: true, path: filePath };
  };

  return {
    currentVersions: {
      privacy: CURRENT_PRIVACY_NOTICE_VERSION,
      terms: CURRENT_TERMS_VERSION,
      face: CURRENT_FACE_RULES_VERSION,
    },
    getState: publicState,
    hasCoreConsent,
    hasFaceRecognitionConsent,
    saveConsent,
    openLegalDocument,
  };
};

module.exports = {
  CURRENT_PRIVACY_NOTICE_VERSION,
  CURRENT_TERMS_VERSION,
  CURRENT_FACE_RULES_VERSION,
  createPrivacyService,
};
