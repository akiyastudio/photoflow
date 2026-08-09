const byId = id => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const NUMBER_FORMATTER = new Intl.NumberFormat('zh-CN');
const FEATURE_LABELS = {
  home: '首页',
  classify: '分类整理',
  inspiration: '灵感库',
  settings: '设置',
  project: '项目',
  'project-team': '团片流程',
  setup_test: '部署测试',
};
const IMPORT_BUCKETS = ['1-20', '21-100', '101-500', '501-2000', '2001+'];

const state = {
  token: '',
  days: 30,
  controller: null,
};

const elements = {
  loginShell: byId('login-shell'),
  appShell: byId('app-shell'),
  loginForm: byId('login-form'),
  loginButton: byId('login-button'),
  tokenInput: byId('token-input'),
  toggleToken: byId('toggle-token'),
  loginError: byId('login-error'),
  periodSelect: byId('period-select'),
  refreshButton: byId('refresh-button'),
  logoutButton: byId('logout-button'),
  retryButton: byId('retry-button'),
  dashboardError: byId('dashboard-error'),
  dashboardErrorText: byId('dashboard-error-text'),
  truncatedWarning: byId('truncated-warning'),
  loadingOverlay: byId('loading-overlay'),
};

const asNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const formatNumber = value => NUMBER_FORMATTER.format(asNumber(value));
const setText = (id, value) => { byId(id).textContent = value; };
const clearElement = element => { while (element.firstChild) element.removeChild(element.firstChild); };

function setLoading(loading) {
  elements.loadingOverlay.hidden = !loading;
  elements.loginButton.disabled = loading;
  elements.refreshButton.disabled = loading;
}

function showLoginError(message) {
  elements.loginError.textContent = message;
  elements.loginError.hidden = !message;
}

function showDashboardError(message) {
  elements.dashboardErrorText.textContent = message;
  elements.dashboardError.hidden = !message;
}

function displayDashboard() {
  elements.loginShell.hidden = true;
  elements.appShell.hidden = false;
}

function logout(message = '') {
  state.controller?.abort();
  state.controller = null;
  state.token = '';
  elements.tokenInput.value = '';
  elements.appShell.hidden = true;
  elements.loginShell.hidden = false;
  setLoading(false);
  showDashboardError('');
  showLoginError(message);
  elements.tokenInput.focus();
}

function formatPercent(rate) {
  return `${(Math.max(0, asNumber(rate)) * 100).toFixed(1)}%`;
}

function formatFeature(feature) {
  const value = String(feature || 'unknown');
  const label = FEATURE_LABELS[value];
  return label ? `${label} · ${value}` : value;
}

function formatDateLabel(dateText) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText || ''));
  return match ? `${Number(match[2])}/${Number(match[3])}` : String(dateText || '');
}

function dateInShanghai(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function fillDailyActive(records, days, generatedAt) {
  const counts = new Map((Array.isArray(records) ? records : [])
    .map(item => [String(item.date || ''), asNumber(item.count)]));
  const endDate = new Date(`${dateInShanghai(generatedAt)}T00:00:00Z`);
  const result = [];
  for (let offset = Math.max(7, asNumber(days)) - 1; offset >= 0; offset -= 1) {
    const date = new Date(endDate.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    result.push({ date, count: counts.get(date) || 0 });
  }
  return result;
}

function createEmptyState(message) {
  const element = document.createElement('div');
  element.className = 'empty-state';
  element.textContent = message;
  return element;
}

function renderDailyActive(records, days, generatedAt) {
  const container = byId('daily-active-chart');
  clearElement(container);
  const points = fillDailyActive(records, days, generatedAt);
  setText('latest-dau', points.length ? formatNumber(points.at(-1).count) : '0');

  if (!points.some(point => point.count > 0)) {
    container.appendChild(createEmptyState('所选周期内还没有活跃数据'));
    return;
  }

  const width = 760;
  const height = 230;
  const padding = { top: 15, right: 14, bottom: 34, left: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maximum = Math.max(1, ...points.map(point => point.count));
  const xFor = index => padding.left + (points.length === 1 ? plotWidth / 2 : index * plotWidth / (points.length - 1));
  const yFor = count => padding.top + plotHeight - (count / maximum) * plotHeight;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-hidden', 'true');

  const defs = document.createElementNS(SVG_NS, 'defs');
  const gradient = document.createElementNS(SVG_NS, 'linearGradient');
  gradient.setAttribute('id', 'activityGradient');
  gradient.setAttribute('x1', '0');
  gradient.setAttribute('y1', '0');
  gradient.setAttribute('x2', '0');
  gradient.setAttribute('y2', '1');
  [['0%', '#4b8cf0', '0.22'], ['100%', '#4b8cf0', '0']].forEach(([offset, color, opacity]) => {
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', color);
    stop.setAttribute('stop-opacity', opacity);
    gradient.appendChild(stop);
  });
  defs.appendChild(gradient);
  svg.appendChild(defs);

  for (let index = 0; index <= 4; index += 1) {
    const y = padding.top + plotHeight * index / 4;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', padding.left);
    line.setAttribute('x2', width - padding.right);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    line.setAttribute('class', 'chart-grid-line');
    svg.appendChild(line);

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', padding.left - 8);
    label.setAttribute('y', y + 3);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', 'chart-axis-label');
    label.textContent = String(Math.round(maximum * (4 - index) / 4));
    svg.appendChild(label);
  }

  const coordinates = points.map((point, index) => [xFor(index), yFor(point.count)]);
  const lineData = coordinates.map(([x, y], index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ');
  const area = document.createElementNS(SVG_NS, 'path');
  area.setAttribute('d', `${lineData} L ${coordinates.at(-1)[0]} ${padding.top + plotHeight} L ${coordinates[0][0]} ${padding.top + plotHeight} Z`);
  area.setAttribute('class', 'chart-area');
  svg.appendChild(area);

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', lineData);
  path.setAttribute('class', 'chart-line');
  svg.appendChild(path);

  const labelEvery = Math.max(1, Math.ceil(points.length / 7));
  points.forEach((point, index) => {
    const [x, y] = coordinates[index];
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', points.length > 31 ? '2' : '3');
    circle.setAttribute('class', 'chart-point');
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `${point.date}：${formatNumber(point.count)}`;
    circle.appendChild(title);
    svg.appendChild(circle);

    if (index % labelEvery === 0 || index === points.length - 1) {
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', x);
      label.setAttribute('y', height - 9);
      label.setAttribute('text-anchor', index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle');
      label.setAttribute('class', 'chart-axis-label');
      label.textContent = formatDateLabel(point.date);
      svg.appendChild(label);
    }
  });
  container.appendChild(svg);
}

function renderRetention(retention = {}) {
  for (const key of ['d1', 'd7', 'd30']) {
    const item = retention[key] || {};
    setText(`retention-${key}`, formatPercent(item.rate));
    setText(`retention-${key}-detail`, `${formatNumber(item.returned)} 人返回 / ${formatNumber(item.cohort)} 人`);
  }
}

function renderFeatureChart(records) {
  const container = byId('feature-chart');
  clearElement(container);
  const features = Array.isArray(records) ? records.slice(0, 10) : [];
  if (!features.length) {
    container.appendChild(createEmptyState('所选周期内还没有功能使用数据'));
    return;
  }
  const maximum = Math.max(1, ...features.map(item => asNumber(item.count)));
  features.forEach(item => {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = formatFeature(item.feature);
    label.title = label.textContent;
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = `${Math.max(2, asNumber(item.count) / maximum * 100)}%`;
    track.appendChild(fill);
    const count = document.createElement('span');
    count.className = 'bar-count';
    count.textContent = formatNumber(item.count);
    row.append(label, track, count);
    container.appendChild(row);
  });
}

function renderImportChart(buckets = {}) {
  const container = byId('import-chart');
  clearElement(container);
  const values = IMPORT_BUCKETS.map(bucket => asNumber(buckets[bucket]));
  const maximum = Math.max(1, ...values);
  IMPORT_BUCKETS.forEach((bucket, index) => {
    const column = document.createElement('div');
    column.className = 'bucket-column';
    const value = document.createElement('span');
    value.className = 'bucket-value';
    value.textContent = formatNumber(values[index]);
    const track = document.createElement('div');
    track.className = 'bucket-track';
    const fill = document.createElement('div');
    fill.className = 'bucket-fill';
    fill.style.height = `${values[index] ? Math.max(4, values[index] / maximum * 100) : 0}%`;
    track.appendChild(fill);
    const label = document.createElement('span');
    label.className = 'bucket-label';
    label.textContent = bucket;
    column.append(value, track, label);
    container.appendChild(column);
  });
}

function renderRankList(id, records, emptyMessage) {
  const container = byId(id);
  clearElement(container);
  const rows = Array.isArray(records) ? records.slice(0, 8) : [];
  if (!rows.length) {
    container.appendChild(createEmptyState(emptyMessage));
    return;
  }
  rows.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'rank-row';
    const rank = document.createElement('span');
    rank.className = 'rank-index';
    rank.textContent = String(index + 1);
    const label = document.createElement('span');
    label.className = 'rank-label';
    label.textContent = String(item.value || 'unknown');
    label.title = label.textContent;
    const count = document.createElement('span');
    count.className = 'rank-count';
    count.textContent = formatNumber(item.count);
    row.append(rank, label, count);
    container.appendChild(row);
  });
}

function renderFeedback(records) {
  const container = byId('feedback-list');
  clearElement(container);
  const items = Array.isArray(records) ? records : [];
  if (!items.length) {
    container.appendChild(createEmptyState('所选周期内还没有问题反馈'));
    return;
  }
  const statusLabels = { new: '待处理', investigating: '处理中', resolved: '已处理', ignored: '已忽略' };
  items.forEach(item => {
    const article = document.createElement('article');
    article.className = 'feedback-item';
    const meta = document.createElement('div');
    meta.className = 'feedback-meta';
    const version = document.createElement('span');
    version.textContent = `v${String(item.appVersion || 'unknown')} · ${String(item.platform || 'unknown')}`;
    const time = document.createElement('time');
    const receivedAt = new Date(item.receivedAt || item.clientTime);
    time.textContent = Number.isNaN(receivedAt.getTime()) ? '时间未知' : receivedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const status = document.createElement('span');
    status.className = `feedback-status status-${String(item.status || 'new')}`;
    status.textContent = statusLabels[item.status] || String(item.status || '待处理');
    meta.append(version, time, status);
    const message = document.createElement('p');
    message.className = 'feedback-message';
    message.textContent = String(item.message || '');
    article.append(meta, message);
    container.appendChild(article);
  });
}

function renderMetrics(metrics) {
  setText('activation-count', formatNumber(metrics.activationCount));
  setText('active-installations', formatNumber(metrics.activeInstallations));
  setText('project-count', formatNumber(metrics.projectCreationCount));
  setText('update-check-count', formatNumber(metrics.updateChecks?.total));
  setText('update-check-caption', `发现可用更新 ${formatNumber(metrics.updateChecks?.updateAvailable)} 次`);
  setText('crash-count', formatNumber(metrics.crashes?.total));
  setText('crash-caption', `影响 ${formatNumber(metrics.crashes?.affectedInstallations)} 个匿名安装`);
  setText('feedback-count', formatNumber(metrics.feedback?.total));
  setText('feedback-caption', `待处理 ${formatNumber(metrics.feedback?.newCount)} 条`);
  renderDailyActive(metrics.dailyActive, metrics.windowDays, metrics.generatedAt);
  renderRetention(metrics.retention);
  renderFeatureChart(metrics.highFrequencyFeatures);
  renderImportChart(metrics.importCountBuckets);
  renderRankList('crashes-by-version', metrics.crashes?.byAppVersion, '没有版本相关崩溃');
  renderRankList('crashes-by-error', metrics.crashes?.byErrorName, '没有错误类型数据');
  renderRankList('crashes-by-process', metrics.crashes?.byProcessType, '没有进程崩溃数据');
  renderFeedback(metrics.feedback?.recent);
  elements.truncatedWarning.hidden = metrics.truncated !== true;

  const generated = new Date(metrics.generatedAt);
  const generatedText = Number.isNaN(generated.getTime())
    ? '数据已加载'
    : `数据生成于 ${generated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`;
  setText('generated-at', `${generatedText} · 统计周期 ${formatNumber(metrics.windowDays)} 天`);
}

async function loadMetrics({ initialLogin = false } = {}) {
  if (!state.token) return;
  state.controller?.abort();
  state.controller = new AbortController();
  setLoading(true);
  showDashboardError('');
  if (initialLogin) showLoginError('');

  try {
    const response = await fetch(`/v1/admin/metrics?days=${encodeURIComponent(state.days)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${state.token}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
      credentials: 'same-origin',
      signal: state.controller.signal,
    });
    if (response.status === 401) {
      logout('Token 不正确，请检查后重新输入。');
      return;
    }
    if (response.status === 429) throw new Error('请求过于频繁，请稍后再试。');
    if (!response.ok) throw new Error(`服务器暂时无法返回数据（HTTP ${response.status}）。`);
    const metrics = await response.json();
    renderMetrics(metrics);
    displayDashboard();
  } catch (error) {
    if (error.name === 'AbortError') return;
    const message = error instanceof Error ? error.message : '读取数据失败。';
    if (initialLogin && elements.appShell.hidden) showLoginError(message);
    else showDashboardError(message);
  } finally {
    setLoading(false);
  }
}

elements.loginForm.addEventListener('submit', event => {
  event.preventDefault();
  const token = elements.tokenInput.value.trim();
  if (!token) {
    showLoginError('请输入管理 Token。');
    return;
  }
  state.token = token;
  state.days = asNumber(elements.periodSelect.value) || 30;
  void loadMetrics({ initialLogin: true });
});

elements.toggleToken.addEventListener('click', () => {
  const showing = elements.tokenInput.type === 'text';
  elements.tokenInput.type = showing ? 'password' : 'text';
  elements.toggleToken.textContent = showing ? '显示' : '隐藏';
  elements.toggleToken.setAttribute('aria-label', showing ? '显示 Token' : '隐藏 Token');
});

elements.periodSelect.addEventListener('change', () => {
  state.days = asNumber(elements.periodSelect.value) || 30;
  void loadMetrics();
});
elements.refreshButton.addEventListener('click', () => void loadMetrics());
elements.retryButton.addEventListener('click', () => void loadMetrics());
elements.logoutButton.addEventListener('click', () => logout());

window.addEventListener('pagehide', () => {
  state.token = '';
  state.controller?.abort();
});
