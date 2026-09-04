const fs = require('node:fs');
const args = process.argv.slice(2); const manifestPath = args[args.indexOf('--manifest') + 1]; const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const candidate = manifest.candidates.find(item => Number(item.personIndex) === 2); const returned = manifest.returned[0];
process.stdout.write(`${JSON.stringify({ type: 'result', result: { matches: [{ ...returned, ...candidate, confidence: 'high', matchConfidence: 1 }] } })}\n`);
