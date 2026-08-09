const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getBinFromUrl } = require('app-builder-lib/out/binDownload');

const nsisChecksum = 'VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q==';
const repositoryRoot = path.resolve(__dirname, '..');
const policyDirectory = path.join(repositoryRoot, 'packaging').replaceAll('\\', '\\\\');
const installerSource = fs.readFileSync(path.join(repositoryRoot, 'packaging', 'installer.nsh'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));

function assertion(input, policy, expected, failureCode) {
  return `
  StrCpy $INSTDIR "${input}"
  StrCpy $PhotoFlowInstallDirectoryPolicy "${policy}"
  Call PhotoFlowApplyInstallDirectoryPolicy
  StrCmp $INSTDIR "${expected}" PhotoFlowCase${failureCode}Passed 0
  SetErrorLevel ${failureCode}
  Quit
  PhotoFlowCase${failureCode}Passed:`;
}

async function main() {
  assert.strictEqual(packageJson.build.nsis.allowToChangeInstallationDirectory, true);
  assert(installerSource.includes('!insertmacro MUI_PAGE_DIRECTORY'), 'the supported custom-page hook must retain the directory chooser');
  assert(installerSource.includes('!macro customInit') && installerSource.includes('StrCmp $perMachineInstallationFolder "" 0 PhotoFlowPreserveRequestedInstallDirectory'), 'an existing registered installation must select the preserve policy during customInit');
  assert(installerSource.includes('${GetOptions} $R0 "/D=" $R1'), 'an explicit /D parameter must be detected without a custom plugin dependency');
  assert(installerSource.includes('Call PhotoFlowApplyInstallDirectoryPolicy'), 'the interactive page must execute the tested directory policy');

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-nsis-directory-'));
  try {
    const outputPath = path.join(temporaryDirectory, 'installer-directory-test.exe');
    const scriptPath = path.join(temporaryDirectory, 'installer-directory-test.nsi');
    const escapedOutputPath = outputPath.replaceAll('\\', '\\\\');
    const script = `Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "PhotoFlow installer directory policy test"
OutFile "${escapedOutputPath}"
!define APP_FILENAME "照片流"
!addincludedir "${policyDirectory}"
!include "installer-directory.nsh"

Section
${assertion('C:\\Program Files\\照片流', 'normalize', 'C:\\Program Files\\照片流', 11)}
${assertion('D:', 'normalize', 'D:\\Program Files\\照片流', 12)}
${assertion('D:\\', 'normalize', 'D:\\Program Files\\照片流', 13)}
${assertion('D:\\temp', 'normalize', 'D:\\Program Files\\照片流', 14)}
${assertion('d:\\TEMP', 'normalize', 'd:\\Program Files\\照片流', 15)}
${assertion('E:\\Existing Product Directory', 'preserve', 'E:\\Existing Product Directory', 16)}
${assertion('Z:\\Enterprise Deployment\\照片流', 'preserve', 'Z:\\Enterprise Deployment\\照片流', 17)}

  StrCpy $INSTDIR "D:\\"
  StrCpy $PhotoFlowInstallDirectoryPolicy "normalize"
  Call PhotoFlowApplyInstallDirectoryPolicy
  StrCmp $INSTDIR "D:\\" 0 PhotoFlowRootCheckPassed
  SetErrorLevel 18
  Quit
  PhotoFlowRootCheckPassed:
  SetErrorLevel 0
SectionEnd
`;
    fs.writeFileSync(scriptPath, script, 'utf8');

    const nsisDirectory = await getBinFromUrl('nsis', '3.0.4.1', nsisChecksum);
    const makensisPath = path.join(nsisDirectory, 'Bin', 'makensis.exe');
    assert(fs.existsSync(makensisPath), `makensis was not found at ${makensisPath}`);

    const compilation = spawnSync(makensisPath, ['-WX', '-INPUTCHARSET', 'UTF8', scriptPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.strictEqual(compilation.status, 0, `NSIS policy compilation failed:\n${compilation.stdout}\n${compilation.stderr}`);

    const execution = spawnSync(outputPath, ['/S'], { encoding: 'utf8' });
    assert.strictEqual(execution.status, 0, `NSIS policy behavior test failed with exit code ${execution.status}`);
    console.log('installer directory NSIS behavior tests passed');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
