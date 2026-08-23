const fs = require('fs');
const path = require('path');

const COMPONENT_HOST_CONTRACT_VERSION = 1;
const COMPONENT_HOST_API_VERSION = 1;
const CONTRIBUTION_TYPES = new Set(['workspace.toolbarAction', 'component.fullPage']);
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

const isInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const requiredText = (value, field, maxLength = 160) => {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) throw new Error(`Invalid component host ${field}`);
  return text;
};

const requiredId = (value, field) => {
  const id = requiredText(value, field, 80);
  if (!IDENTIFIER.test(id)) throw new Error(`Invalid component host ${field}`);
  return id;
};

const parseComponentHostManifest = (manifest, componentRoot) => {
  const host = manifest?.componentHost;
  if (host === undefined) return null; // Existing native V1 components remain valid.
  if (Number(manifest.apiVersion) !== 1) throw new Error(`Unsupported component apiVersion: ${manifest.apiVersion}`);
  if (!host || typeof host !== 'object' || Array.isArray(host)) throw new Error('Invalid componentHost manifest');
  if (Number(host.contractVersion) !== COMPONENT_HOST_CONTRACT_VERSION) throw new Error(`Unsupported component host contractVersion: ${host.contractVersion}`);
  const compatibility = host.compatibility;
  if (!compatibility || typeof compatibility !== 'object') throw new Error('Missing component host compatibility range');
  const min = Number(compatibility.minHostApiVersion);
  const max = Number(compatibility.maxHostApiVersion);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) throw new Error('Invalid component host compatibility range');
  if (COMPONENT_HOST_API_VERSION < min || COMPONENT_HOST_API_VERSION > max) throw new Error(`Component host API ${COMPONENT_HOST_API_VERSION} is outside supported range ${min}-${max}`);
  if (!Array.isArray(host.contributions) || host.contributions.length < 2 || host.contributions.length > 32) throw new Error('Component host contributions must be a bounded array');

  const componentId = requiredId(manifest.id, 'component id');
  const seen = new Set();
  const pages = new Map();
  const actions = [];
  for (const raw of host.contributions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid component host contribution');
    if (!CONTRIBUTION_TYPES.has(raw.type)) throw new Error(`Unknown component host contribution type: ${raw.type || 'missing'}`);
    const id = requiredId(raw.id, `${raw.type} id`);
    const key = `${raw.type}:${id}`;
    if (seen.has(key)) throw new Error(`Duplicate component host contribution: ${key}`);
    seen.add(key);
    if (raw.type === 'component.fullPage') {
      const relativeEntry = requiredText(raw.entry, 'page entry', 512).replace(/\\/g, '/');
      const entry = path.resolve(componentRoot, relativeEntry);
      if (!isInside(componentRoot, entry)) throw new Error('Component page entry escapes component root');
      const stat = fs.statSync(entry, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Component page entry is missing or unsafe: ${relativeEntry}`);
      pages.set(id, { type: raw.type, id, title: requiredText(raw.title, 'page title'), entry, relativeEntry });
    } else {
      actions.push({ type: raw.type, id, label: requiredText(raw.label, 'toolbar label', 80), pageId: requiredId(raw.pageId, 'toolbar pageId') });
    }
  }
  if (pages.size !== 1 || actions.length !== 1) throw new Error('Component Host V1 requires exactly one toolbar action and one full page');
  if (!pages.has(actions[0].pageId)) throw new Error(`Component toolbar action references an unknown page: ${actions[0].pageId}`);
  const page = pages.get(actions[0].pageId);
  return Object.freeze({
    componentId,
    componentVersion: requiredText(manifest.version, 'component version', 80),
    contractVersion: COMPONENT_HOST_CONTRACT_VERSION,
    hostApiVersion: COMPONENT_HOST_API_VERSION,
    compatibility: { minHostApiVersion: min, maxHostApiVersion: max },
    toolbarAction: Object.freeze({ ...actions[0], pageTitle: page.title }),
    fullPage: Object.freeze(page),
  });
};

const createComponentHostRegistry = ({ roots }) => {
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
        values.push({ componentRoot, source: root.source });
      }
    }
    return values;
  };
  const inspectRoot = ({ componentRoot, source }) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(componentRoot, 'component.json'), 'utf8'));
    const descriptor = parseComponentHostManifest(manifest, componentRoot);
    return descriptor ? { ...descriptor, componentRoot, source } : null;
  };
  const list = () => {
    const byId = new Map();
    for (const candidate of candidates()) {
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
  COMPONENT_HOST_CONTRACT_VERSION,
  CONTRIBUTION_TYPES,
  createComponentHostRegistry,
  parseComponentHostManifest,
};
