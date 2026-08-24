const LEGACY_COMPONENT_DOMAINS: Readonly<Record<string, string>> = {
  'team-retouch': 'team-retouch',
};

/** Resolves domain IDs emitted before health snapshots carried a componentId. */
export const legacyComponentIdForDomain = (domainId: string) => LEGACY_COMPONENT_DOMAINS[domainId];
