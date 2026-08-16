const PROJECT_FILE_LIST_QUERY_MAX_LENGTH = 160;

const normalizeProjectFileListFilter = value => {
  const allowedKinds = new Set(['file', 'image', 'raw', 'video', 'shortcut']);
  const kinds = [...new Set((Array.isArray(value?.kinds) ? value.kinds : []).map(kind => String(kind).toLowerCase()).filter(kind => allowedKinds.has(kind)))].sort();
  const extensions = [...new Set((Array.isArray(value?.extensions) ? value.extensions : []).map(extension => String(extension).trim().toLowerCase()).filter(Boolean).map(extension => extension.startsWith('.') ? extension : `.${extension}`))].sort();
  const query = String(value?.query || '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, PROJECT_FILE_LIST_QUERY_MAX_LENGTH).toLocaleLowerCase('zh-CN');
  return { query, kinds, extensions, signature: JSON.stringify({ query, kinds, extensions }) };
};

const projectFileListSessionMatches = (session, root, scope, filter) => Boolean(session
  && session.root === root && session.scope === scope && session.filterSignature === filter.signature);

const projectFileListEntryMatchesFilter = (name, kind, extension, filter) => (!filter.query || String(name).normalize('NFKC').toLocaleLowerCase('zh-CN').includes(filter.query))
  && (!filter.kinds.length || filter.kinds.includes(kind))
  && (!filter.extensions.length || filter.extensions.includes(extension));

module.exports = { normalizeProjectFileListFilter, projectFileListEntryMatchesFilter, projectFileListSessionMatches };
