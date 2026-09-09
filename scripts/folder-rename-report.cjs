const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const milliseconds = value => Number.isFinite(value) ? value.toFixed(1) : '—';
const stageNames = {
  'virtualPath.listManagedExternalLinks': '递归扫描外链',
  componentFolderPolicyDiscovery: '插件文件夹保护规则发现',
  registeredProgressQuery: '版本登记查询（含工作进程等待）',
  registeredProgressSnapshot: '版本登记只读快照',
  nativeRenameIncludingProcessStartup: '原生改名服务（含进程启动）',
  undoIdentityCapture: '撤销身份采集',
  progressMutationLease: '版本树变更锁',
  progressDatabaseAndFilesystemCommit: '版本目录数据库与文件系统提交',
  workspaceCatalogRefresh: '工作区目录刷新',
  externalWatcherRefresh: '外链监听刷新',
};
const renderRenameReport = report => {
  const lines = ['# 文件夹重命名分段计时', '', `采样时间：${report.createdAt}`, '',
    '测量对象为本机独立 Electron 测试实例和人工生成的目录。每种场景通过真实 IPC 连续改名 5 次；随后使用真实列表界面的选择按钮、F2 输入框和 Enter 各改名 1 次。界面样本均核对对应后端成功记录和实际目标目录。', '',
    '“小目录／大目录”分别含 20／1,000 个填充子目录，另有待改名目录和已登记版本节点。后台监听保持启用，目录为空，不代表客户媒体目录或网络盘。', '',
    '| 场景 | 改名请求中位数（毫秒，5 次） | 当前目录读取中位数（毫秒） | 界面恢复可操作（毫秒，单次） |',
    '| --- | ---: | ---: | ---: |'];
  for (const project of ['Rename-small', 'Rename-large']) {
    for (const kind of ['ordinary', 'progress']) {
      const scenario = `${project}/${kind}`;
      const api = report.samples.filter(sample => sample.scenario === scenario);
      const ui = report.samples.find(sample => sample.scenario === `${scenario}/ui`);
      lines.push(`| ${project.endsWith('small') ? '小目录' : '大目录'} · ${kind === 'ordinary' ? '普通文件夹' : '版本进度文件夹'} | ${milliseconds(median(api.map(sample => sample.ipcMs)))} | ${milliseconds(median(api.map(sample => sample.directoryRefreshMs)))} | ${milliseconds(ui?.uiActionableMs)} |`);
    }
  }
  lines.push('', '## 后端分段', '', '各阶段在一次请求中可能调用多次，下表先按请求合计，再取 5 次中位数。各列中位数不来自同一次请求，不能相加当作总耗时。', '',
    '| 阶段 | 小目录普通 | 大目录普通 | 小目录版本 | 大目录版本 |', '| --- | ---: | ---: | ---: | ---: |');
  for (const [stage, label] of Object.entries(stageNames)) {
    const values = ['Rename-small/ordinary', 'Rename-large/ordinary', 'Rename-small/progress', 'Rename-large/progress'].map(scenario => {
      const rows = report.samples.filter(sample => sample.scenario === scenario).map(sample => report.backend[sample.backendIndex]);
      if (!rows.some(row => row?.stages.some(item => item.stage === stage))) return '—';
      return milliseconds(median(rows.map(row => row.stages.filter(item => item.stage === stage).reduce((sum, item) => sum + item.durationMs, 0))));
    });
    lines.push(`| ${label}（毫秒） | ${values.join(' | ')} |`);
  }
  lines.push('', '## 结论与边界', '',
    '- 表格反映当前代码的耗时分布，可与同方法的基线报告比较；优化收益以完整请求和实际界面测量为准。',
    '- 原生改名服务计时包含进程启动与协议往返，不能解读为操作系统改名调用本身耗时。版本提交目前合并记录数据库与文件系统工作，尚未拆到内核调用。',
    '- 撤销信息采集与当前目录列表读取可用上表直接判断占比，避免在低耗时环节投入优化。',
    '- 界面单次值和 IPC 中位数属于不同请求，且后台负载不同，不可直接相减推算渲染耗时。界面采样约每 10 毫秒检查一次；测试使用现有 smoke 模式的离屏／软件渲染设置。',
    '- 所有计时仅在双重诊断开关下收集，正常启动不启用。原始 JSON、测试数据库和失败运行证据均留在私有诊断目录。', '');
  if (report.error) lines.push(`本次运行未完整通过：${report.error}`, '');
  return lines.join('\n');
};
module.exports = { renderRenameReport, median };
