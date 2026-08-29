const assert = require('node:assert/strict');
const { parseComponentSettingsForm, normalizeComponentSettingsFormValues, validateComponentSettingsFormPatch } = require('../electron/contracts/component-settings-form-contract.cjs');

const declaration = { schemaVersion: 1, groups: [
  { id: 'general', title: 'General', description: 'Shared host-rendered settings.', fields: [
    { id: 'enabled', type: 'toggle', label: 'Enabled', default: true },
    { id: 'mode', type: 'select', label: 'Mode', default: 'balanced', options: [{ value: 'fast', label: 'Fast' }, { value: 'balanced', label: 'Balanced' }] },
    { id: 'name', type: 'text', label: 'Name', default: '', maxLength: 40, placeholder: 'Optional' },
    { id: 'workers', type: 'number', label: 'Workers', default: 2, min: 1, max: 8, step: 1 },
    { id: 'quality', type: 'range', label: 'Quality', default: 80, min: 1, max: 100, step: 1, suffix: '%' },
  ] },
] };
const form = parseComponentSettingsForm(declaration);
assert.equal(form.schemaVersion, 1); assert.equal(form.groups[0].fields.length, 5); assert(Object.isFrozen(form.groups[0].fields));
assert.deepEqual(normalizeComponentSettingsFormValues(form, { enabled: false, mode: 'invalid', workers: 4 }), { enabled: false, mode: 'balanced', name: '', workers: 4, quality: 80 });
assert.deepEqual(validateComponentSettingsFormPatch(form, { enabled: false, quality: 90 }), { enabled: false, quality: 90 });
for (const patch of [{}, { missing: true }, { enabled: 'yes' }, { mode: 'invalid' }, { workers: 100 }, { name: 'x'.repeat(41) }]) assert.throws(() => validateComponentSettingsFormPatch(form, patch), /Settings form|Invalid settings/);
for (const invalid of [
  { ...declaration, schemaVersion: 2 },
  { schemaVersion: 1, groups: [{ id: 'x', title: 'X', fields: [{ id: 'same', type: 'toggle', label: 'A', default: true }, { id: 'same', type: 'toggle', label: 'B', default: false }] }] },
  { schemaVersion: 1, groups: [{ id: 'x', title: 'X', fields: [{ id: 'mode', type: 'select', label: 'Mode', default: 'missing', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }] }] },
]) assert.throws(() => parseComponentSettingsForm(invalid));
console.log('Component declarative settings form contract tests passed');
