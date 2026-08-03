const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');
const legalRoot = path.join(repositoryRoot, 'docs', 'legal');
const outputPath = path.join(legalRoot, 'INSTALLER_TERMS.html');

const readHtml = name => fs.readFileSync(path.join(legalRoot, name), 'utf8');
const extract = (html, pattern, label) => {
  const match = html.match(pattern);
  if (!match) throw new Error(`无法从法律文件中提取${label}`);
  return match[1].trim();
};
const demoteHeadings = html => html.replace(/<(\/?)h([1-3])>/g, (_match, closing, level) => `<${closing}h${Number(level) + 1}>`);

const termsHtml = readHtml('USER_AGREEMENT.html');
const privacyHtml = readHtml('PRIVACY_POLICY.html');
const styles = extract(termsHtml, /<style>([\s\S]*?)<\/style>/i, '样式');
const termsBody = demoteHeadings(extract(termsHtml, /<main>([\s\S]*?)<\/main>/i, '用户协议'));
const privacyBody = demoteHeadings(extract(privacyHtml, /<main>([\s\S]*?)<\/main>/i, '隐私政策'));

const document = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>照片流安装条款与隐私说明</title>
  <style>
${styles}
    .installer-summary { margin: 1.25em 0 2em; padding: 18px 20px; border: 1px solid #bfdbfe; border-radius: 12px; background: #eff6ff; color: #1e3a8a; }
    .installer-summary strong { color: #172554; }
    .document-section { margin-top: 3em; padding-top: 2em; border-top: 3px solid #cbd5e1; }
    .document-section > h2 { margin-top: 0; color: #0f172a; font-size: 1.65rem; }
  </style>
</head>
<body>
  <main>
    <h1>照片流安装条款与隐私说明</h1>
    <p>安装前请完整阅读本页。只有明确接受后，安装程序才会继续。</p>
    <div class="installer-summary">
      <strong>重要提示：</strong>照片流当前为受控内测版。参加内测需要发送使用统计和崩溃报告；统计不上传照片、文件名、完整路径或项目名称。跨照片人物身份识别是可选功能，安装不会自动启用，实际使用前仍会另行展示规则并取得单独同意。
    </div>
    <p>点击安装程序中的“我接受”表示你已阅读、理解并同意下方《照片流用户协议及内测条款》和《照片流隐私政策》。如果不同意，请退出安装程序。</p>
    <section class="document-section" aria-label="用户协议">
${termsBody.split('\n').map(line => `      ${line}`).join('\n')}
    </section>
    <section class="document-section" aria-label="隐私政策">
${privacyBody.split('\n').map(line => `      ${line}`).join('\n')}
    </section>
  </main>
</body>
</html>
`;

fs.writeFileSync(outputPath, document, 'utf8');
process.stdout.write(`Generated ${path.relative(repositoryRoot, outputPath)}\n`);
