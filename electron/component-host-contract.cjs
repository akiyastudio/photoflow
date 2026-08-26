const fs = require('fs');
const path = require('path');

const COMPONENT_HOST_CONTRACT_VERSION = 2;
const COMPONENT_HOST_API_VERSION = 5;
const COMPONENT_HOST_MIN_API_VERSION = 2;
const COMPONENT_SERVICE_PROTOCOL_VERSION = 1;
const CONTRIBUTION_TYPES = new Set(['workspace.toolbarAction', 'component.fullPage', 'application.settingsPage']);
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const VERSIONED_METHOD = /^[a-z][a-z0-9.-]{0,119}\.v[1-9][0-9]*$/;
const HOST_CAPABILITIES = new Set([
  'project.media.page.v2', 'project.media.variants.v2', 'project.input.tokens.v2',
  'project.output.v2', 'version.create.v2', 'tasks.v2', 'dialogs.v2',
  'component.storage.v2', 'component.settings.v2', 'component.events.v2',
  'component.lifecycle.v2', 'component.media.v2', 'project.progress.v2',
  'notifications.v2',
  'project.files.page.v1', 'project.files.search.v1', 'project.media.metadata.v1',
  'project.versions.page.v1', 'project.version.graph.v1', 'project.media.ratings.v1',
]);
const HOST_PERMISSIONS = new Set([
  'project.media.read', 'project.input.read', 'project.output.write',
  'project.version.create', 'component.storage', 'component.settings',
  'tasks', 'dialogs', 'events', 'component.lifecycle.read', 'component.lifecycle.manage',
  'component.media', 'project.progress',
  'notifications',
  'project.files.read', 'project.versions.read', 'project.media.ratings.read',
]);
const CAPABILITY_PERMISSIONS = Object.freeze({
  'project.media.page.v2': 'project.media.read',
  'project.media.variants.v2': 'project.media.read',
  'project.input.tokens.v2': 'project.input.read',
  'project.output.v2': 'project.output.write',
  'version.create.v2': 'project.version.create',
  'tasks.v2': 'tasks',
  'dialogs.v2': 'dialogs',
  'component.storage.v2': 'component.storage',
  'component.settings.v2': 'component.settings',
  'component.events.v2': 'events',
  'component.lifecycle.v2': 'component.lifecycle.read',
  'component.media.v2': 'component.media',
  'project.progress.v2': 'project.progress',
  'notifications.v2': 'notifications',
  'project.files.page.v1': 'project.files.read',
  'project.files.search.v1': 'project.files.read',
  'project.media.metadata.v1': 'project.media.read',
  'project.versions.page.v1': 'project.versions.read',
  'project.version.graph.v1': 'project.versions.read',
  'project.media.ratings.v1': 'project.media.ratings.read',
});
const COMPONENT_ICON_MIME_TYPES = new Map([['.png', 'image/png'], ['.svg', 'image/svg+xml']]);
const MAX_COMPONENT_ICON_BYTES = 512 * 1024;

const isInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const requiredText = (value, field, maxLength = 160) => {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) throw new Error(`Invalid component host ${field}`);
  return text;
};
const requiredStringText = (value, field, maxLength = 160) => {
  if (typeof value !== 'string') throw new Error(`Invalid component host ${field}`);
  return requiredText(value, field, maxLength);
};
const requiredExactStringText = (value, field, maxLength = 160) => {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maxLength) throw new Error(`Invalid component host ${field}`);
  return value;
};
const requiredExactId = (value, field) => {
  const id = requiredExactStringText(value, field, 80);
  if (!IDENTIFIER.test(id)) throw new Error(`Invalid component host ${field}`);
  return id;
};

const requiredId = (value, field) => {
  const id = requiredText(value, field, 80);
  if (!IDENTIFIER.test(id)) throw new Error(`Invalid component host ${field}`);
  return id;
};
const rejectUnknownFields = (value, allowed, label) => {
  const unknown = Object.keys(value || {}).filter(field => !allowed.includes(field));
  if (unknown.length) throw new Error(`Unknown ${label} field: ${unknown[0]}`);
};

const resolveDevelopmentFile = ({ declaredEntry, componentRoot, overrideRoot, overrideEntry, label }) => {
  const declared = path.resolve(componentRoot, declaredEntry);
  if (!isInside(componentRoot, declared)) throw new Error(`${label} escapes component root`);
  const resolvedOverrideRoot = path.resolve(overrideRoot);
  const resolvedOverride = path.resolve(overrideEntry);
  if (!isInside(resolvedOverrideRoot, resolvedOverride)) throw new Error(`${label} development override escapes its approved root`);
  const rootStat = fs.lstatSync(resolvedOverrideRoot, { throwIfNoEntry: false });
  const entryStat = fs.lstatSync(resolvedOverride, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || !entryStat?.isFile() || entryStat.isSymbolicLink()) throw new Error(`${label} development override is missing or unsafe`);
  const realRoot = fs.realpathSync(resolvedOverrideRoot); const realEntry = fs.realpathSync(resolvedOverride);
  if (!isInside(realRoot, realEntry)) throw new Error(`${label} development override escapes its approved root through a linked path`);
  return realEntry;
};
const resolvePackageFile = ({ relativeEntry, componentRoot, developmentOverride = null, label }) => {
  const declaredEntry = path.resolve(componentRoot, relativeEntry);
  if (!isInside(componentRoot, declaredEntry)) throw new Error(`${label} escapes component root`);
  if (developmentOverride) return resolveDevelopmentFile({ declaredEntry: relativeEntry, componentRoot, ...developmentOverride, label });
  const rootStat = fs.lstatSync(componentRoot, { throwIfNoEntry: false });
  const entryStat = fs.lstatSync(declaredEntry, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || !entryStat?.isFile() || entryStat.isSymbolicLink()) throw new Error(`${label} is missing or unsafe: ${relativeEntry}`);
  const realRoot = fs.realpathSync(componentRoot);
  const realEntry = fs.realpathSync(declaredEntry);
  if (!isInside(realRoot, realEntry)) throw new Error(`${label} escapes component root through a linked path`);
  return realEntry;
};

const developmentOverrideFor = (developmentFiles, relativeEntry) => {
  const overrideEntry = developmentFiles?.files?.[String(relativeEntry || '').replace(/\\/g, '/')];
  return overrideEntry ? { overrideRoot: developmentFiles.componentRoot, overrideEntry } : null;
};

const parseComponentIcon = (value, componentRoot, developmentOverride = null) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Invalid component icon declaration');
  const relativeEntry = requiredText(value, 'icon', 512).replace(/\\/g, '/');
  if (/^[a-z][a-z0-9+.-]*:/i.test(relativeEntry) || relativeEntry.startsWith('//')) throw new Error('Component icon must be a package-local file');
  const declaredEntry = path.resolve(componentRoot, relativeEntry);
  if (!isInside(componentRoot, declaredEntry)) throw new Error('Component icon escapes component root');
  const entry = developmentOverride ? resolveDevelopmentFile({ declaredEntry: relativeEntry, componentRoot, ...developmentOverride, label: 'Component icon' }) : declaredEntry;
  const mimeType = COMPONENT_ICON_MIME_TYPES.get(path.extname(entry).toLowerCase());
  if (!mimeType) throw new Error('Component icon must be SVG or PNG');
  const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_COMPONENT_ICON_BYTES) throw new Error(`Component icon is missing or unsafe: ${relativeEntry}`);
  const realRoot = fs.realpathSync(developmentOverride?.overrideRoot || componentRoot); const realEntry = fs.realpathSync(entry);
  if (!isInside(realRoot, realEntry)) throw new Error('Component icon escapes component root through a linked path');
  const bytes = fs.readFileSync(realEntry);
  if (mimeType === 'image/png') {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Component PNG icon has an invalid signature');
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 1024 || height > 1024) throw new Error('Component PNG icon dimensions are invalid');
  } else {
    const svg = bytes.toString('utf8').trim();
    if (!/^<svg[\s>]/i.test(svg)
      || /<\/?(?:script|foreignObject|iframe|object|embed|audio|video|image|use|style)\b/i.test(svg)
      || /<!DOCTYPE|<\?xml-stylesheet/i.test(svg)
      || /\son[a-z]+\s*=/i.test(svg)
      || /(?:^|[\s:])(?:href|src)\s*=/i.test(svg)) throw new Error('Component SVG icon contains active or external content');
    for (const match of svg.matchAll(/url\(\s*([^)]*)\s*\)/gi)) {
      if (!String(match[1] || '').trim().startsWith('#')) throw new Error('Component SVG icon contains an external resource');
    }
  }
  return Object.freeze({ entry: realEntry, relativeEntry, mimeType });
};

const parseComponentHostManifest = (manifest, componentRoot, developmentFiles = null) => {
  const host = manifest?.componentHost;
  if (host === undefined) return null;
  if (Number(manifest.apiVersion) !== 1) throw new Error(`Unsupported component apiVersion: ${manifest.apiVersion}`);
  if (!host || typeof host !== 'object' || Array.isArray(host)) throw new Error('Invalid componentHost manifest');
  const contractVersion = Number(host.contractVersion);
  if (contractVersion !== COMPONENT_HOST_CONTRACT_VERSION) throw new Error(`Unsupported component host contractVersion: ${host.contractVersion}`);
  rejectUnknownFields(host, ['contractVersion', 'compatibility', 'contributions', 'service', 'adoptionGrants'], 'component host');
  const compatibility = host.compatibility;
  if (!compatibility || typeof compatibility !== 'object') throw new Error('Missing component host compatibility range');
  rejectUnknownFields(compatibility, ['minHostApiVersion', 'maxHostApiVersion'], 'component compatibility');
  const min = Number(compatibility.minHostApiVersion);
  const max = Number(compatibility.maxHostApiVersion);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) throw new Error('Invalid component host compatibility range');
  const negotiatedHostApiVersion = Math.min(COMPONENT_HOST_API_VERSION, max);
  if (negotiatedHostApiVersion < Math.max(COMPONENT_HOST_MIN_API_VERSION, min)) throw new Error(`Component host APIs ${COMPONENT_HOST_MIN_API_VERSION}-${COMPONENT_HOST_API_VERSION} do not overlap supported range ${min}-${max}`);
  if (negotiatedHostApiVersion < 2) throw new Error('Component Host contractVersion 2 requires Host API 2 or newer');
  if (!Array.isArray(host.contributions) || host.contributions.length < 2 || host.contributions.length > 32) throw new Error('Component host contributions must be a bounded array');

  const componentId = requiredId(manifest.id, 'component id');
  const allowedAdoptionGrants = new Set(['component.storage.previous.v1', 'project.output.existing.v1']);
  const adoptionGrants = host.adoptionGrants === undefined ? [] : host.adoptionGrants;
  if (!Array.isArray(adoptionGrants) || adoptionGrants.length > allowedAdoptionGrants.size || new Set(adoptionGrants).size !== adoptionGrants.length || adoptionGrants.some(grant => !allowedAdoptionGrants.has(grant))) throw new Error('Invalid component host adoption grants');
  const icon = parseComponentIcon(manifest.icon, componentRoot, developmentOverrideFor(developmentFiles, manifest.icon) || developmentFiles?.icon || null);
  const seen = new Set();
  const pages = new Map();
  const actions = [];
  const settingsPages = [];
  for (const raw of host.contributions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid component host contribution');
    if (!CONTRIBUTION_TYPES.has(raw.type)) throw new Error(`Unknown component host contribution type: ${raw.type || 'missing'}`);
    const id = raw.type === 'application.settingsPage' ? requiredExactId(raw.id, 'application settings page id') : requiredId(raw.id, `${raw.type} id`);
    const key = `${raw.type}:${id}`;
    if (seen.has(key)) throw new Error(`Duplicate component host contribution: ${key}`);
    seen.add(key);
    if (raw.type === 'component.fullPage') {
      rejectUnknownFields(raw, ['type', 'id', 'title', 'entry'], 'component fullPage contribution');
      const relativeEntry = requiredText(raw.entry, 'page entry', 512).replace(/\\/g, '/');
      const entry = resolvePackageFile({ relativeEntry, componentRoot, developmentOverride: developmentOverrideFor(developmentFiles, relativeEntry) || developmentFiles?.page, label: 'Component page entry' });
      pages.set(id, { type: raw.type, id, title: requiredText(raw.title, 'page title'), entry, relativeEntry });
    } else if (raw.type === 'workspace.toolbarAction') {
      rejectUnknownFields(raw, ['type', 'id', 'label', 'pageId'], 'component toolbarAction contribution');
      actions.push({ type: raw.type, id, label: requiredText(raw.label, 'toolbar label', 80), pageId: requiredId(raw.pageId, 'toolbar pageId') });
    } else {
      if (negotiatedHostApiVersion < 3) throw new Error('Application settings pages require Host API 3');
      if (min < 3) throw new Error('Application settings pages require minHostApiVersion 3 or newer');
      rejectUnknownFields(raw, ['type', 'id', 'label', 'title', 'entry', 'rpcMethods'], 'application settingsPage contribution');
      const relativeEntry = requiredExactStringText(raw.entry, 'settings page entry', 512).replace(/\\/g, '/');
      const entry = resolvePackageFile({ relativeEntry, componentRoot, developmentOverride: developmentOverrideFor(developmentFiles, relativeEntry) || developmentFiles?.settingsPages?.[id], label: 'Component settings page entry' });
      if (!Array.isArray(raw.rpcMethods) || raw.rpcMethods.length < 1 || raw.rpcMethods.length > 32 || raw.rpcMethods.some(method => typeof method !== 'string')) throw new Error('Component settings page RPC methods must be a bounded versioned allowlist');
      const rpcMethods = raw.rpcMethods.map(value => requiredExactStringText(value, 'settings page RPC method', 128));
      if (new Set(rpcMethods).size !== rpcMethods.length) throw new Error('Component settings page RPC methods must not contain duplicates');
      if (rpcMethods.some(method => !VERSIONED_METHOD.test(method))) throw new Error('Component settings page RPC methods must be a bounded versioned allowlist');
      const label = requiredExactStringText(raw.label, 'settings page label', 80);
      settingsPages.push(Object.freeze({ type: raw.type, id, label, title: raw.title === undefined ? label : requiredExactStringText(raw.title, 'settings page title'), entry, relativeEntry, rpcMethods: Object.freeze(rpcMethods) }));
    }
  }
  if (settingsPages.length > 16) throw new Error('Component settings page contributions must be bounded');
  if (pages.size !== 1 || actions.length !== 1) throw new Error('Component Host requires exactly one toolbar action and one full page');
  if (!pages.has(actions[0].pageId)) throw new Error(`Component toolbar action references an unknown page: ${actions[0].pageId}`);
  const page = pages.get(actions[0].pageId);
  let service = null;
  if (host.service === undefined) throw new Error('Component Host V2 requires a service declaration');
  if (host.service !== undefined) {
    const raw = host.service;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid component service manifest');
    rejectUnknownFields(raw, ['protocolVersion', 'runtime', 'entrypoints', 'rpcMethods', 'capabilities', 'permissions', 'events', 'runtimeActions', 'lifecycleActions', 'projectFolders'], 'component service');
    if (Number(raw.protocolVersion) !== COMPONENT_SERVICE_PROTOCOL_VERSION) throw new Error(`Unsupported component service protocolVersion: ${raw.protocolVersion}`);
    if (!['node', 'executable'].includes(raw.runtime)) throw new Error('Invalid component service runtime');
    const entries = raw.entrypoints;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Missing component service entrypoints');
    const platformKey = `${process.platform}-${process.arch}`;
    const relativeEntry = requiredText(entries[platformKey] || entries[process.platform] || entries.default, 'service entry', 512).replace(/\\/g, '/');
    const entry = resolvePackageFile({ relativeEntry, componentRoot, developmentOverride: developmentOverrideFor(developmentFiles, relativeEntry), label: 'Component service entry' });
    const rpcMethods = [...new Set((raw.rpcMethods || []).map(value => requiredText(value, 'service RPC method', 128)))];
    if (!rpcMethods.length || rpcMethods.length > 128 || rpcMethods.some(method => !VERSIONED_METHOD.test(method))) throw new Error('Component service RPC methods must be a bounded versioned allowlist');
    const capabilities = [...new Set((raw.capabilities || []).map(value => requiredText(value, 'service capability', 128)))];
    if (capabilities.length > 32 || capabilities.some(capability => !HOST_CAPABILITIES.has(capability))) throw new Error('Component service requests an unknown host capability');
    const permissions = [...new Set((raw.permissions || []).map(value => requiredText(value, 'service permission', 128)))];
    if (permissions.length > 32 || permissions.some(permission => !HOST_PERMISSIONS.has(permission))) throw new Error('Component service requests an unknown host permission');
    if (contractVersion === 2 && !Array.isArray(raw.permissions)) throw new Error('Component Host V2 service must declare a permissions allowlist');
    for (const capability of capabilities) {
      const permission = CAPABILITY_PERMISSIONS[capability];
      if (permission && !permissions.includes(permission)) throw new Error(`Component capability ${capability} requires permission ${permission}`);
    }
    if (capabilities.includes('notifications.v2') || permissions.includes('notifications')) {
      if (min < 4) throw new Error('Notifications require minHostApiVersion 4 or newer');
      if (raw.capabilities.some(value => typeof value !== 'string' || value !== value.trim()) || new Set(raw.capabilities).size !== raw.capabilities.length) throw new Error('Host API 4 capabilities must be exact and unique');
      if (raw.permissions.some(value => typeof value !== 'string' || value !== value.trim()) || new Set(raw.permissions).size !== raw.permissions.length) throw new Error('Host API 4 permissions must be exact and unique');
    }
    const hostApi5Declaration = capabilities.some(value => ['project.files.page.v1', 'project.files.search.v1', 'project.media.metadata.v1', 'project.versions.page.v1', 'project.version.graph.v1', 'project.media.ratings.v1'].includes(value))
      || permissions.some(value => ['project.files.read', 'project.versions.read', 'project.media.ratings.read'].includes(value));
    if (hostApi5Declaration) {
      if (min < 5) throw new Error('Project read extensions require minHostApiVersion 5 or newer');
      if (raw.capabilities.some(value => typeof value !== 'string' || value !== value.trim()) || new Set(raw.capabilities).size !== raw.capabilities.length) throw new Error('Host API 5 capabilities must be exact and unique');
      if (raw.permissions.some(value => typeof value !== 'string' || value !== value.trim()) || new Set(raw.permissions).size !== raw.permissions.length) throw new Error('Host API 5 permissions must be exact and unique');
    }
    const events = [...new Set((raw.events || []).map(value => requiredText(value, 'service event', 128)))];
    if (events.length > 32 || events.some(event => !VERSIONED_METHOD.test(event))) throw new Error('Component service events must be a bounded versioned allowlist');
    const runtimeActions = [...new Set((raw.runtimeActions || []).map(value => requiredId(value, 'runtime action')))];
    if (runtimeActions.length > 32) throw new Error('Component runtime actions must be a bounded allowlist');
    if (raw.projectFolders !== undefined && !Array.isArray(raw.projectFolders)) throw new Error('Component project folders must be a bounded array');
    if ((raw.projectFolders || []).length > 32) throw new Error('Component project folders must be a bounded array');
    const projectFolderNames = new Set();
    const projectFolders = (raw.projectFolders || []).map(declaration => {
      if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) throw new Error('Invalid component project folder declaration');
      rejectUnknownFields(declaration, ['name', 'protectFromGenericRename', 'reserveProgressRelocationName', 'legacyAdoptionGrant'], 'component project folder');
      const name = requiredExactStringText(declaration.name, 'project folder name', 160);
      if (name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) throw new Error('Invalid component project folder name');
      const nameKey = name.toLocaleLowerCase('zh-CN');
      if (projectFolderNames.has(nameKey)) throw new Error('Duplicate component project folder declaration');
      projectFolderNames.add(nameKey);
      if (declaration.protectFromGenericRename !== undefined && typeof declaration.protectFromGenericRename !== 'boolean') throw new Error('Invalid component project folder protection');
      if (declaration.reserveProgressRelocationName !== undefined && typeof declaration.reserveProgressRelocationName !== 'boolean') throw new Error('Invalid component project folder protection');
      const protectFromGenericRename = declaration.protectFromGenericRename === true;
      const reserveProgressRelocationName = declaration.reserveProgressRelocationName === true;
      if (!protectFromGenericRename && !reserveProgressRelocationName) throw new Error('Component project folder declaration must request a protection');
      const legacyAdoptionGrant = declaration.legacyAdoptionGrant === undefined ? null : requiredExactStringText(declaration.legacyAdoptionGrant, 'project folder legacy adoption grant', 128);
      if (legacyAdoptionGrant && !adoptionGrants.includes(legacyAdoptionGrant)) throw new Error('Component project folder legacy adoption grant is not granted');
      return Object.freeze({ name, protectFromGenericRename, reserveProgressRelocationName, legacyAdoptionGrant });
    });
    const lifecycleActions = {};
    for (const [action, declaration] of Object.entries(raw.lifecycleActions || {})) {
      const actionId = requiredId(action, 'lifecycle action');
      if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) throw new Error(`Invalid component lifecycle action: ${actionId}`);
      const relativeActionEntry = requiredText(declaration.entry, 'lifecycle action entry', 512).replace(/\\/g, '/');
      const actionEntry = resolvePackageFile({ relativeEntry: relativeActionEntry, componentRoot, developmentOverride: developmentOverrideFor(developmentFiles, relativeActionEntry), label: 'Component lifecycle action entry' });
      const sha256 = requiredText(declaration.sha256, 'lifecycle action SHA-256', 64).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Invalid component lifecycle action SHA-256: ${actionId}`);
      lifecycleActions[actionId] = Object.freeze({ entry: actionEntry, relativeEntry: relativeActionEntry, sha256 });
    }
    if (Object.keys(lifecycleActions).length > 16) throw new Error('Component lifecycle actions must be bounded');
    service = Object.freeze({
      protocolVersion: COMPONENT_SERVICE_PROTOCOL_VERSION,
      runtime: raw.runtime,
      entry,
      relativeEntry,
      rpcMethods: Object.freeze(rpcMethods),
      capabilities: Object.freeze(capabilities),
      permissions: Object.freeze(permissions),
      events: Object.freeze(events),
      runtimeActions: Object.freeze(runtimeActions),
      lifecycleActions: Object.freeze(lifecycleActions),
      projectFolders: Object.freeze(projectFolders),
    });
    for (const settingsPage of settingsPages) {
      const unknownMethod = settingsPage.rpcMethods.find(method => !rpcMethods.includes(method));
      if (unknownMethod) throw new Error(`Component settings page RPC method is not declared by the service: ${unknownMethod}`);
    }
  }
  let advancedRuntime = null;
  if (manifest.advancedRuntime !== undefined) {
    const raw = manifest.advancedRuntime;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid advanced runtime compatibility manifest');
    const apiVersion = Number(raw.apiVersion);
    if (!Number.isInteger(apiVersion) || apiVersion < 1) throw new Error('Invalid advanced runtime API version');
    const compatibleLegacyComponentVersions = [...new Set((raw.compatibleLegacyComponentVersions || []).map(value => requiredText(value, 'legacy component version', 80)))];
    if (compatibleLegacyComponentVersions.length > 16 || compatibleLegacyComponentVersions.some(version => !/^\d{2}\.\d{1,2}\.\d{1,2}\.\d+$/.test(version))) {
      throw new Error('Invalid advanced runtime legacy compatibility list');
    }
    advancedRuntime = Object.freeze({ apiVersion, compatibleLegacyComponentVersions: Object.freeze(compatibleLegacyComponentVersions) });
  }
  return Object.freeze({
    componentId,
    componentVersion: requiredText(manifest.version, 'component version', 80),
    contractVersion,
    hostApiVersion: negotiatedHostApiVersion,
    compatibility: { minHostApiVersion: min, maxHostApiVersion: max },
    adoptionGrants: Object.freeze([...adoptionGrants]),
    toolbarAction: Object.freeze({ ...actions[0], pageTitle: page.title }),
    fullPage: Object.freeze(page),
    settingsPages: Object.freeze(settingsPages),
    icon,
    service,
    advancedRuntime,
  });
};

const createComponentHostRegistry = ({ roots = [], candidateProvider = null, admitDescriptor = null }) => {
  const candidates = () => {
    const values = [];
    for (const root of roots) {
      let entries = [];
      try { entries = fs.readdirSync(root.path, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || !IDENTIFIER.test(entry.name)) continue;
        const container = path.join(root.path, entry.name);
        const runtime = path.join(container, 'runtime');
        const componentRoot = fs.existsSync(path.join(runtime, 'component.json')) ? runtime : container;
        const manifestPath = path.join(componentRoot, 'component.json');
        if (fs.existsSync(manifestPath)) values.push({ componentRoot, manifestPath, expectedId: entry.name, source: root.source });
      }
    }
    return values;
  };
  const inspectRoot = ({ componentRoot, manifestPath = path.join(componentRoot, 'component.json'), manifest: providedManifest = null, developmentFiles = null, developmentRuntime = null, expectedId = '', source }) => {
    const manifest = providedManifest || JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (expectedId && manifest.id !== expectedId) throw new Error(`Component id does not match its directory: ${manifest.id || 'missing'}`);
    const descriptor = parseComponentHostManifest(manifest, componentRoot, developmentFiles);
    if (descriptor && admitDescriptor && admitDescriptor(descriptor, componentRoot, source) !== true) throw new Error(`Component host admission rejected: ${descriptor.componentId}`);
    return descriptor ? { ...descriptor, componentRoot, source, ...(developmentFiles ? { development: true } : {}), ...(developmentRuntime ? { developmentRuntime } : {}) } : null;
  };
  const list = () => {
    const byId = new Map();
    for (const candidate of candidateProvider ? candidateProvider() : candidates()) {
      try {
        const descriptor = inspectRoot(candidate);
        if (descriptor && !byId.has(descriptor.componentId)) byId.set(descriptor.componentId, descriptor);
      } catch { /* malformed UI components are rejected, not partially registered */ }
    }
    return [...byId.values()];
  };
  const resolve = componentId => list().find(item => item.componentId === componentId) || null;
  return { list, resolve, inspectRoot };
};

module.exports = {
  COMPONENT_HOST_API_VERSION,
  COMPONENT_HOST_MIN_API_VERSION,
  COMPONENT_HOST_CONTRACT_VERSION,
  COMPONENT_SERVICE_PROTOCOL_VERSION,
  CONTRIBUTION_TYPES,
  HOST_CAPABILITIES,
  HOST_PERMISSIONS,
  CAPABILITY_PERMISSIONS,
  COMPONENT_ICON_MIME_TYPES,
  MAX_COMPONENT_ICON_BYTES,
  createComponentHostRegistry,
  parseComponentIcon,
  resolvePackageFile,
  parseComponentHostManifest,
};
