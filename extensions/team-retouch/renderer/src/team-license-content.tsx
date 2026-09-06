import catalog from '../../licenses/catalog.json';
import './team-license.css';

export const TeamLicenseContent = () => <section className="pf-settings-group team-license-section">
  <h2 className="pf-settings-group-title">模型与第三方许可</h2>
  <p className="pf-settings-group-description">以下为团片协作使用的模型和运行库。增强版条目仅适用于安装增强环境后的功能；基础版不包含增强模型。</p>
  <div className="pf-settings-card">
    {catalog.models.map(model => <details key={model.bundledFile} className="team-license-item">
      <summary><span>{model.name}</span><span className="team-license-meta">{model.scope === 'base' ? '基础模型' : '增强模型'} · {model.license}</span></summary>
      <div className="team-license-body">
        <p>{model.purpose}</p><p>{model.version}</p>
        <p className="team-license-path">{model.bundledFile}</p>
        <p className="team-license-path">SHA-256：{model.sha256}</p>
        <p>来源地址（可复制）</p><p className="team-license-path">{model.sourceUrl}</p>
        <p>{model.downloadNote}</p>
        <details><summary>许可证全文</summary><pre>{model.licenseText}</pre></details>
      </div>
    </details>)}
    {catalog.software.map(item => <details key={item.name} className="team-license-item">
      <summary><span>{item.name}</span><span className="team-license-meta">{item.group} · {item.license}</span></summary>
      <div className="team-license-body"><p>{item.version} · {item.purpose}</p>{item.note && <p>{item.note}</p>}<p>来源与许可地址（可复制）</p><p className="team-license-path">{item.sourceUrl}</p><p className="team-license-path">{item.licenseUrl}</p></div>
    </details>)}
  </div>
</section>;
