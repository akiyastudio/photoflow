const CURRENT_PRIVACY_NOTICE_VERSION = '2026-08-30';
const CURRENT_TERMS_VERSION = '2026-08-30';
const CURRENT_FACE_RULES_VERSION = '2026-07-29';
const INSTALL_CONSENT_FILE_NAME = 'install-consent.ini';
const INSTALL_CONSENT_SCHEMA_VERSION = '2';

const LEGAL_DOCUMENTS = Object.freeze({
  privacy: 'PRIVACY_POLICY.html',
  terms: 'USER_AGREEMENT.html',
  face: 'FACE_RECOGNITION_RULES.html',
  'information-list': 'PERSONAL_INFORMATION_LIST.html',
  'third-parties': 'THIRD_PARTY_SERVICES.html',
  permissions: 'PERMISSIONS.html',
  children: 'CHILDREN_PRIVACY.html',
  'customer-data': 'CUSTOMER_DATA_PROCESSING_TERMS.html',
  'open-source': 'OPEN_SOURCE_NOTICES.html',
});

const parseInstallerConsent = content => {
  const values = {};
  let section = '';
  for (const rawLine of String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    if (section !== 'Consent') continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
};

const createPrivacyService = ({ app, fs, path, shell, projectRoot, now = () => new Date(), platform = process.platform }) => {
  const statePath = path.join(app.getPath('userData'), 'privacy-consent.json');
  const installConsentPath = path.join(app.getPath('userData'), INSTALL_CONSENT_FILE_NAME);
  const legalRoot = () => app.isPackaged
    ? path.join(process.resourcesPath, 'legal')
    : path.join(projectRoot, 'docs', 'legal');

  const readStateFile = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const writeStateSync = state => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  };

  const importInstallerConsent = state => {
    if (!app.isPackaged || platform !== 'win32' || !fs.existsSync(installConsentPath)) return state;
    if (state.privacyNoticeVersion === CURRENT_PRIVACY_NOTICE_VERSION && state.termsVersion === CURRENT_TERMS_VERSION) return state;
    try {
      const receipt = parseInstallerConsent(fs.readFileSync(installConsentPath, 'utf8'));
      if (receipt.SchemaVersion !== INSTALL_CONSENT_SCHEMA_VERSION || receipt.Interactive !== '1') return state;
      if (receipt.PrivacyVersion !== CURRENT_PRIVACY_NOTICE_VERSION || receipt.TermsVersion !== CURRENT_TERMS_VERSION) return state;
      if (!['0', '1'].includes(receipt.ExperienceProgram)) return state;
      if (!receipt.InstallerVersion || !/^\d+(?:\.\d+)+$/.test(receipt.InstallerVersion)) return state;
      const acceptedAt = new Date(receipt.AcceptedAtLocal);
      const acceptedAtMs = acceptedAt.getTime();
      const currentTime = now();
      const currentTimeMs = currentTime.getTime();
      if (!Number.isFinite(acceptedAtMs) || !Number.isFinite(currentTimeMs) || acceptedAtMs > currentTimeMs + 10 * 60 * 1000) return state;
      const revokedAtMs = Date.parse(String(state.coreConsentRevokedAt || ''));
      if (state.coreConsentRevokedAt && (!Number.isFinite(revokedAtMs) || acceptedAtMs <= revokedAtMs)) return state;
      const imported = {
        ...state,
        privacyNoticeVersion: CURRENT_PRIVACY_NOTICE_VERSION,
        privacyNoticeAcceptedAt: acceptedAt.toISOString(),
        termsVersion: CURRENT_TERMS_VERSION,
        termsAcceptedAt: acceptedAt.toISOString(),
        coreConsentRevokedAt: '',
        coreConsentSource: 'interactive-installer',
        installerConsentImportedAt: currentTime.toISOString(),
        installerVersion: receipt.InstallerVersion,
        experienceProgramGranted: receipt.ExperienceProgram === '1',
      };
      writeStateSync(imported);
      return imported;
    } catch {
      return state;
    }
  };

  const readState = () => importInstallerConsent(readStateFile());

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
      experienceProgramGranted: state.experienceProgramGranted === true,
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
    const savedAt = now().toISOString();
    if (request?.revokeCore === true) {
      state.privacyNoticeVersion = '';
      state.privacyNoticeAcceptedAt = '';
      state.termsVersion = '';
      state.termsAcceptedAt = '';
      state.coreConsentRevokedAt = savedAt;
      state.coreConsentSource = '';
      state.experienceProgramGranted = false;
    }
    if (request?.acceptCore === true) {
      state.privacyNoticeVersion = CURRENT_PRIVACY_NOTICE_VERSION;
      state.privacyNoticeAcceptedAt = savedAt;
      state.termsVersion = CURRENT_TERMS_VERSION;
      state.termsAcceptedAt = savedAt;
      state.coreConsentRevokedAt = '';
      state.coreConsentSource = 'application';
      state.experienceProgramGranted = request?.experienceProgramGranted === true;
    }
    if (typeof request?.faceRecognitionGranted === 'boolean') {
      state.faceRecognitionGranted = request.faceRecognitionGranted;
      state.faceRulesVersion = request.faceRecognitionGranted ? CURRENT_FACE_RULES_VERSION : '';
      state.faceRecognitionGrantedAt = request.faceRecognitionGranted ? savedAt : '';
    }
    await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
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
  INSTALL_CONSENT_FILE_NAME,
  INSTALL_CONSENT_SCHEMA_VERSION,
  parseInstallerConsent,
  createPrivacyService,
};
