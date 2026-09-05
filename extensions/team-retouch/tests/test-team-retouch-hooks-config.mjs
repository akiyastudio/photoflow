import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import eslintRisk from 'eslint/use-at-your-own-risk';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { FlatESLint } = eslintRisk;
const eslint = new FlatESLint({ cwd: root });
const [result] = await eslint.lintText(`
  import { useEffect } from 'react';
  export function MissingDependency({ value }) {
    useEffect(() => { console.log(value); }, []);
    return null;
  }
`, { filePath: path.join(root, 'renderer/src/exhaustive-deps-fixture.tsx') });
assert(result.messages.some(message => message.ruleId === 'react-hooks/exhaustive-deps' && message.severity === 2), 'the real renderer ESLint config rejects missing hook dependencies as an error');
console.log('Team-retouch hooks configuration tests passed');
