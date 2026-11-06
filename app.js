/* ==========================================================================
   Picker Wheel · 大转盘
   纯静态、零依赖。Canvas 绘制 + rAF 缓动旋转。
   ========================================================================== */

(() => {
  'use strict';

  /* ---------- 常量 ---------- */

  const MIN_DURATION = 5;
  const MAX_DURATION = 600;
  /** 最近一次使用的转盘（含内容与时间戳）。 */
  const STORE_KEY = 'picker-wheel/recent';
  /** 转动时长属于设备偏好，单独存；不参与分享，也不影响默认转盘。 */
  const DURATION_KEY = 'picker-wheel/duration';

  /**
   * 分享链接只用 `w` 一个参数：转盘内容本身。
   * 时长是个人偏好，不参与分享，减少链接长度。
   */
  const SHARE_PARAM = 'w';
  const SHARE_VERSION = '1';
  /** 编码后的参数长度上限：过长的链接会被聊天工具、二维码截断。 */
  const SHARE_MAX_ENCODED = 1800;

  const FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", ' +
    '"Hiragino Sans GB", "Noto Sans SC", system-ui, sans-serif';

  /** 莫奈 / 马卡龙柔和色板，按色相环排布，相邻色差异大。 */
  const PALETTE = [
    '#F6D8CC', '#F9E5C9', '#F2EFC6', '#DDEBC8',
    '#C8E6D3', '#BFDFDE', '#C6DCEE', '#CFD9F0',
    '#DCD4EC', '#ECD3E6', '#F5D4DC', '#EFE6CF',
    '#D6E9DD', '#DEE6F2', '#E9DCEF', '#F3DFD2',
  ];

  /** 首次打开（既无分享链接也无本地记录）时的转盘。 */
  const DEFAULT_LINES = ['1', '2', '3', '4', '5', '6'];

  const PRESETS = [
    { name: '摇骰子', desc: '1 ~ 6', lines: DEFAULT_LINES },
    { name: '四选一', desc: 'A / B / C / D', lines: ['A', 'B', 'C', 'D'] },
    { name: '正反抉择', desc: '正 / 反', lines: ['正', '反'] },
    {
      name: '正反交替',
      desc: '12 份 · 正反间隔',
      lines: Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? '正' : '反')),
    },
  ];

  /* ---------- DOM ---------- */

  const els = {
    canvas: document.getElementById('wheel'),
    wheelWrap: document.getElementById('wheelWrap'),
    stage: document.querySelector('.stage'),
    hub: document.getElementById('hub'),
    hubCaption: document.getElementById('hubCaption'),
    hubValue: document.getElementById('hubValue'),
    spinBtn: document.getElementById('spinBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    panel: document.getElementById('panel'),
    scrim: document.getElementById('scrim'),
    closeBtn: document.getElementById('closeBtn'),
    lines: document.getElementById('lines'),
    duration: document.getElementById('duration'),
    presets: document.getElementById('presets'),
    applyBtn: document.getElementById('applyBtn'),
    panelHint: document.getElementById('panelHint'),
    offlineBadge: document.getElementById('offlineBadge'),
    shareUrl: document.getElementById('shareUrl'),
    copyBtn: document.getElementById('copyBtn'),
  };

  const ctx = els.canvas.getContext('2d');

  const state = {
    segments: [],
    rotation: 0,
    spinning: false,
    durationSec: MIN_DURATION,
    size: 320,
    dpr: 1,
    raf: 0,
  };

  /* ---------- 工具函数 ---------- */

  const rad = (deg) => (deg * Math.PI) / 180;
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const normDeg = (deg) => ((deg % 360) + 360) % 360;

  function parseLines(text) {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * 连续相同的内容合并为一份，权重累加。
   *
   * 转盘是圆形，首尾在 0° 处相接，所以「相邻」必须按环形判断：
   * - A、A、B、C：前两行相邻           → 3 份，A 占 50%
   * - A、B、C、A：首尾的 A 在圆周上相接 → 3 份，A 占 50%
   * - A、B、A、C：两个 A 隔着 B 和 C    → 4 份，各占 25%
   */
  function buildSegments(lines) {
    if (!lines.length) return [];

    const segments = [];
    for (const label of lines) {
      const last = segments[segments.length - 1];
      if (last && last.label === label) last.weight += 1;
      else segments.push({ label, weight: 1 });
    }

    // 环形收尾：末端与首端同内容时并成一个扇区。
    // 合并后整体顺序不变（相当于整盘旋转），扇区本身不跨越 0°，
    // 因此 segmentAt / 绘制都不需要处理跨界的特殊情况。
    if (
      segments.length > 1 &&
      segments[0].label === segments[segments.length - 1].label
    ) {
      segments[0].weight += segments.pop().weight;
    }

    const total = lines.length || 1;
    let cumulative = 0;
    for (const seg of segments) {
      seg.start = (cumulative / total) * 360;
      cumulative += seg.weight;
      seg.sweep = (cumulative / total) * 360 - seg.start;
    }
    return segments;
  }

  function colorAt(index, count) {
    if (count <= PALETTE.length) {
      // 均匀抽样，保证每一份颜色都不相同
      return PALETTE[Math.floor((index * PALETTE.length) / count)];
    }
    const hue = (index * 137.508) % 360;
    const sat = 40 + ((index * 13) % 14);
    const light = 83 + ((index * 5) % 7);
    return `hsl(${hue.toFixed(1)} ${sat}% ${light}%)`;
  }

  /* ---------- 分享链接的编解码 ---------- */

  /**
   * 手写 UTF-8 编码：不依赖 TextEncoder，file:// 打开与 Node 测试环境都能用。
   * 按码位遍历（for...of），因此 emoji 等代理对字符不会被拆坏。
   */
  function utf8Encode(text) {
    const bytes = [];
    for (const char of text) {
      const code = char.codePointAt(0);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        bytes.push(
          0xe0 | (code >> 12),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      }
    }
    return bytes;
  }

  function utf8Decode(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; ) {
      const b0 = bytes[i++];
      let code;
      if (b0 < 0x80) {
        code = b0;
      } else if (b0 < 0xe0) {
        code = ((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f);
      } else if (b0 < 0xf0) {
        code =
          ((b0 & 0x0f) << 12) |
          ((bytes[i++] & 0x3f) << 6) |
          (bytes[i++] & 0x3f);
      } else {
        code =
          ((b0 & 0x07) << 18) |
          ((bytes[i++] & 0x3f) << 12) |
          ((bytes[i++] & 0x3f) << 6) |
          (bytes[i++] & 0x3f);
      }
      text += String.fromCodePoint(code);
    }
    return text;
  }

  /** 内容 → `1.<base64url>`，比 percent-encoding 短得多（中文尤其明显）。 */
  function encodeShare(text) {
    if (!text || typeof btoa !== 'function') return '';
    let binary = '';
    for (const byte of utf8Encode(text)) binary += String.fromCharCode(byte);
    const base64 = btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `${SHARE_VERSION}.${base64}`;
  }

  /** 解码失败一律返回空串，由调用方决定降级策略。 */
  function decodeShare(encoded) {
    if (!encoded || typeof atob !== 'function') return '';
    const raw = String(encoded);
    const dot = raw.indexOf('.');
    if (dot < 0 || raw.slice(0, dot) !== SHARE_VERSION) return '';

    const base64 = raw.slice(dot + 1).replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);

    try {
      const binary = atob(padded);
      const bytes = new Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return parseLines(utf8Decode(bytes)).join('\n');
    } catch (error) {
      return '';
    }
  }

  /* ---------- 缓动曲线：起步加速 → 高速 → 平滑减速 ---------- */

  const EASE_SAMPLES = 1024;
  const EASE_ACCEL = 0.14; // 加速段占比
  const EASE_DECEL_POW = 1.9; // 减速陡峭度

  const easeTable = (() => {
    const acc = new Float64Array(EASE_SAMPLES + 1);
    const dt = 1 / EASE_SAMPLES;
    let sum = 0;

    for (let i = 1; i <= EASE_SAMPLES; i++) {
      const t = (i - 0.5) * dt;
      const v =
        t <= EASE_ACCEL
          ? t / EASE_ACCEL
          : Math.pow((1 - t) / (1 - EASE_ACCEL), EASE_DECEL_POW);
      sum += Math.max(v, 0) * dt;
      acc[i] = sum;
    }
    for (let i = 0; i <= EASE_SAMPLES; i++) acc[i] /= sum;
    return acc;
  })();

  function easeProgress(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const x = t * EASE_SAMPLES;
    const i = Math.floor(x);
    const f = x - i;
    return easeTable[i] + (easeTable[i + 1] - easeTable[i]) * f;
  }

  /* ---------- 文字适配 ---------- */

  function fitText(text, maxWidth, maxFont, minFont) {
    if (!text || maxWidth < 10) return null;

    let font = Math.max(minFont, Math.round(maxFont * 10) / 10);
    ctx.font = `600 ${font}px ${FONT_STACK}`;
    const width = ctx.measureText(text).width;
    if (width <= maxWidth) return { font, text };

    const scaled = (font * maxWidth) / width;
    if (scaled >= minFont) {
      return { font: Math.floor(scaled * 10) / 10, text };
    }

    font = minFont;
    ctx.font = `600 ${font}px ${FONT_STACK}`;
    const chars = Array.from(text);
    while (chars.length > 1) {
      chars.pop();
      if (ctx.measureText(chars.join('') + '…').width <= maxWidth) break;
    }
    return { font, text: chars.join('') + '…' };
  }

  /* ---------- 绘制 ---------- */

  function draw() {
    const { size, dpr, segments } = state;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const center = size / 2;
    const radius = center - Math.max(2, size * 0.01);

    if (!segments.length) {
      ctx.beginPath();
      ctx.arc(center, center, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.fill();

      ctx.setLineDash([size * 0.012, size * 0.022]);
      ctx.lineWidth = Math.max(1, size * 0.004);
      ctx.strokeStyle = 'rgba(47, 58, 64, 0.16)';
      ctx.beginPath();
      ctx.arc(center, center, radius - size * 0.055, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    ctx.save();
    ctx.translate(center, center);
    ctx.rotate(-Math.PI / 2 + rad(state.rotation));

    // 扇区
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, rad(seg.start), rad(seg.start + seg.sweep));
      ctx.closePath();
      ctx.fillStyle = colorAt(i, segments.length);
      ctx.fill();
    }

    // 扇区之间的白色分隔线
    if (segments.length > 1) {
      ctx.lineWidth = Math.max(1.1, size * 0.0032);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.beginPath();
      for (const seg of segments) {
        const angle = rad(seg.start);
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
      }
      ctx.stroke();
    }

    // 文字：沿半径方向，末端靠近外缘
    const innerText = size * 0.29; // 避开圆心圆盘与向上探出的指针
    const outerText = radius - size * 0.032;
    const maxTextWidth = outerText - innerText;
    const midRadius = (innerText + outerText) / 2;

    for (const seg of segments) {
      if (seg.sweep < 4) continue;

      // 扇区在文字所在半径处的可用宽度，决定字号上限
      const availHeight = 2 * midRadius * Math.sin(rad(seg.sweep) / 2);
      const maxFont = clamp(
        Math.min(size * 0.05, availHeight * 0.6),
        8,
        size * 0.06
      );
      const fitted = fitText(seg.label, maxTextWidth, maxFont, 8);
      if (!fitted) continue;

      const midAngle = seg.start + seg.sweep / 2;

      ctx.save();
      ctx.rotate(rad(midAngle));
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${fitted.font}px ${FONT_STACK}`;
      ctx.fillStyle = 'rgba(42, 54, 60, 0.84)';

      // 左半侧的扇区把文字翻转，避免文字上下颠倒
      if (Math.sin(rad(midAngle)) < 0) {
        ctx.rotate(Math.PI);
        ctx.textAlign = 'left';
        ctx.fillText(fitted.text, -outerText, 0);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText(fitted.text, outerText, 0);
      }
      ctx.restore();
    }

    // 干净的外缘
    ctx.lineWidth = Math.max(1, size * 0.004);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  function updateSize() {
    // 取短边：stage 的可用宽高（扣除真实 padding），再少量留白
    const style = window.getComputedStyle(els.stage);
    const padX =
      parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);

    const availableW = els.stage.clientWidth - padX - 8;
    const availableH = els.stage.clientHeight - padY - 8;
    const size = Math.max(140, Math.min(availableW, availableH, 640));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    state.size = size;
    state.dpr = dpr;
    els.wheelWrap.style.setProperty('--wheel-size', size + 'px');
    els.canvas.width = Math.round(size * dpr);
    els.canvas.height = Math.round(size * dpr);
    draw();
  }

  /* ---------- 结果判定 ---------- */

  function segmentAt(rotation) {
    const segments = state.segments;
    if (!segments.length) return null;

    const offset = normDeg(-rotation);
    for (const seg of segments) {
      if (offset >= seg.start && offset < seg.start + seg.sweep) return seg;
    }
    return segments[segments.length - 1];
  }

  function pickSegment() {
    const segments = state.segments;
    const totalWeight = segments.reduce((sum, seg) => sum + seg.weight, 0);
    let ticket = Math.random() * totalWeight;
    for (const seg of segments) {
      ticket -= seg.weight;
      if (ticket <= 0) return seg;
    }
    return segments[segments.length - 1];
  }

  /* ---------- 转动 ---------- */

  function spin() {
    if (state.spinning || !state.segments.length || isPanelOpen()) return;

    const target = pickSegment();
    const targetOffset = target.start + target.sweep * (0.18 + Math.random() * 0.64);
    const desired = normDeg(-targetOffset);
    const delta = normDeg(desired - normDeg(state.rotation));

    const turns = 5 + Math.floor(Math.random() * 3); // 5 ~ 7 圈
    const totalDeg = turns * 360 + delta;
    const from = state.rotation;
    const durationMs = state.durationSec * 1000;
    const startTime = performance.now();

    state.spinning = true;
    state.rotation = normDeg(state.rotation);
    setSpinningUi(true);

    const step = (now) => {
      const t = clamp((now - startTime) / durationMs, 0, 1);
      state.rotation = from + totalDeg * easeProgress(t);
      draw();

      if (t < 1) {
        state.raf = requestAnimationFrame(step);
      } else {
        state.raf = 0;
        state.rotation = normDeg(from + totalDeg);
        finishSpin();
      }
    };

    state.raf = requestAnimationFrame(step);
  }

  function finishSpin() {
    state.spinning = false;
    const seg = segmentAt(state.rotation);
    setSpinningUi(false, seg ? seg.label : '');
  }

  /* ---------- 界面状态 ---------- */

  function setSpinningUi(spinning, label) {
    els.spinBtn.disabled = spinning;
    els.settingsBtn.disabled = spinning;
    els.spinBtn.classList.toggle('is-hidden', spinning);
    els.hub.classList.toggle('is-spinning', spinning);
    els.hub.classList.remove('is-result');

    if (spinning) {
      els.hubCaption.textContent = '转动中';
      els.hubValue.textContent = '···';
      return;
    }

    if (typeof label === 'string' && label) {
      // 重新触发高亮动画
      void els.hub.offsetWidth;
      els.hub.classList.add('is-result');
      els.hubCaption.textContent = '结果';
      els.hubValue.textContent = label;
      els.spinBtn.textContent = '再转一次';
    } else {
      els.hubCaption.textContent = '份数';
      els.hubValue.textContent = String(state.segments.length);
    }
  }

  function showIdleHub() {
    els.hub.classList.remove('is-spinning', 'is-result');
    els.hubCaption.textContent = '份数';
    els.hubValue.textContent = String(state.segments.length);
  }

  function hint(message, isError) {
    els.panelHint.textContent = message || '';
    els.panelHint.classList.toggle('is-error', Boolean(isError));
  }

  function summaryText() {
    const lineCount = parseLines(els.lines.value).length;
    const segCount = state.segments.length;
    const merged = lineCount - segCount;
    const tail = merged > 0 ? `，相邻相同项已合并 ${merged} 次` : '';
    return `共 ${lineCount} 行 → ${segCount} 份${tail}`;
  }

  /* ---------- 应用输入 ---------- */

  function applyInput(options) {
    const silent = Boolean(options && options.silent);
    const text = els.lines.value;
    const lines = parseLines(text);

    if (!lines.length) {
      if (!silent) hint('请至少输入一行内容', true);
      return false;
    }

    // 保持当前角度，避免编辑时转盘突然回正闪动
    state.segments = buildSegments(lines);

    draw();
    if (!state.spinning) {
      showIdleHub();
      els.spinBtn.textContent = '开始';
    }
    return true;
  }

  function readDuration() {
    const value = Number(els.duration.value);
    if (!Number.isFinite(value)) return MIN_DURATION;
    return clamp(Math.round(value), MIN_DURATION, MAX_DURATION);
  }

  function saveDuration(seconds) {
    try {
      localStorage.setItem(DURATION_KEY, String(seconds));
    } catch (error) {
      /* 隐私模式下写入失败，忽略即可 */
    }
  }

  function loadDuration() {
    try {
      const value = Number(localStorage.getItem(DURATION_KEY));
      if (!Number.isFinite(value) || !value) return MIN_DURATION;
      return clamp(Math.round(value), MIN_DURATION, MAX_DURATION);
    } catch (error) {
      return MIN_DURATION;
    }
  }

  /* ---------- 设置面板 ---------- */

  function isPanelOpen() {
    return els.panel.classList.contains('is-open');
  }

  function openPanel() {
    if (state.spinning || isPanelOpen()) return;
    els.panel.classList.add('is-open');
    els.scrim.classList.add('is-open');
    els.panel.setAttribute('aria-hidden', 'false');
    els.settingsBtn.setAttribute('aria-expanded', 'true');
    hint(summaryText());
    refreshShareField();
    window.setTimeout(() => els.panel.focus({ preventScroll: true }), 80);
  }

  function closePanel() {
    if (!isPanelOpen()) return;
    els.panel.classList.remove('is-open');
    els.scrim.classList.remove('is-open');
    els.panel.setAttribute('aria-hidden', 'true');
    els.settingsBtn.setAttribute('aria-expanded', 'false');
    if (document.activeElement && els.panel.contains(document.activeElement)) {
      els.settingsBtn.focus({ preventScroll: true });
    }
  }

  /* ---------- 预设 ---------- */

  /**
   * 快捷方案 = 内置方案 + 一张「最近使用」卡片（若有）。
   * 卡片列表由 `presetEntries()` 统一给出，渲染、点击、高亮都基于它，
   * 避免三处各自拼接顺序而出错。
   */
  function presetEntries() {
    const entries = PRESETS.map((preset, index) => ({
      index,
      name: preset.name,
      desc: preset.desc,
      lines: preset.lines,
    }));

    const recent = loadRecent();
    if (recent && !hasLines(entries, recent.text)) {
      const lines = parseLines(recent.text);
      entries.push({
        index: entries.length,
        name: formatRecentTime(recent.at),
        desc: summarizeLines(lines),
        lines,
        recent: true,
      });
    }
    return entries;
  }

  function hasLines(entries, text) {
    return entries.some((entry) => entry.lines.join('\n') === text);
  }

  function createPresetButton(entry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset';
    btn.dataset.index = String(entry.index);
    if (entry.recent) btn.dataset.recent = '1';

    const title = document.createElement('b');
    title.textContent = entry.name;

    const desc = document.createElement('span');
    desc.textContent = entry.desc;

    btn.append(title, desc);
    return btn;
  }

  function renderPresets() {
    const current = parseLines(els.lines.value).join('\n');
    const frag = document.createDocumentFragment();

    for (const entry of presetEntries()) {
      const btn = createPresetButton(entry);
      btn.classList.toggle('is-active', entry.lines.join('\n') === current);
      frag.appendChild(btn);
    }
    els.presets.replaceChildren(frag);
  }

  /** 只切高亮，不重建 DOM——每次输入都重建会让点击态闪烁。 */
  function syncPresetActive() {
    const current = parseLines(els.lines.value).join('\n');
    const entries = presetEntries();

    for (const btn of Array.from(els.presets.children)) {
      const entry = entries[Number(btn.dataset.index)];
      const same = Boolean(entry) && entry.lines.join('\n') === current;
      btn.classList.toggle('is-active', same);
    }
  }

  /* ---------- 分享链接 ---------- */

  /** 参与分享的内容：按解析后的行重组，空行与首尾空格不会污染链接。 */
  function shareableText() {
    return parseLines(els.lines.value).join('\n');
  }

  function isShareableProtocol() {
    const protocol = window.location && window.location.protocol;
    return protocol === 'http:' || protocol === 'https:';
  }

  /**
   * 当前输入 → 完整分享链接，形如 `?w=1.xxxx`。
   * 返回空串表示无法分享：内容为空 / 过长 / 环境拿不到地址。
   *
   * 只带 `w` 一个参数：时长是设备偏好，不该通过链接传播。
   * 无关参数（utm 等）原样保留，`action=spin` 则被剔除，
   * 否则对方打开链接会莫名其妙地自动开转。
   */
  function buildShareUrl() {
    const text = shareableText();
    if (!text || typeof URL !== 'function') return '';
    if (!isShareableProtocol()) return '';

    const href = window.location && window.location.href;
    if (!href) return '';

    const encoded = encodeShare(text);
    // 超长链接会被聊天工具或二维码截断，宁可明确告知不可分享
    if (!encoded || encoded.length > SHARE_MAX_ENCODED) return '';

    let url;
    try {
      url = new URL(href);
    } catch (error) {
      return '';
    }

    url.searchParams.delete('action');
    url.searchParams.set(SHARE_PARAM, encoded);
    return url.toString();
  }

  function refreshShareField() {
    const url = buildShareUrl();

    els.shareUrl.value = url;
    els.copyBtn.disabled = !url;

    if (!isShareableProtocol()) {
      els.shareUrl.placeholder = '通过 http(s) 打开后才能分享链接';
    } else if (!shareableText()) {
      els.shareUrl.placeholder = '输入内容后自动生成';
    } else if (!url) {
      els.shareUrl.placeholder = '内容过长，无法生成分享链接';
    } else {
      els.shareUrl.placeholder = '已生成，可复制分享';
    }
  }

  /** 把当前转盘写回地址栏，方便直接复制浏览器地址。 */
  function syncUrl() {
    const url = buildShareUrl();
    if (!url) return;

    const history = window.history;
    if (!history || typeof history.replaceState !== 'function') return;

    try {
      history.replaceState(null, '', url);
    } catch (error) {
      /* file:// 或隐私模式下不可写，忽略即可 */
    }
  }

  async function copyText(text) {
    const nav = window.navigator;
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      try {
        await nav.clipboard.writeText(text);
        return true;
      } catch (error) {
        /* 权限被拒时退回 execCommand */
      }
    }

    try {
      const temp = document.createElement('textarea');
      temp.value = text;
      temp.setAttribute('readonly', '');
      temp.style.position = 'fixed';
      temp.style.top = '-1000px';
      temp.style.opacity = '0';
      document.body.appendChild(temp);
      temp.select();
      const done = document.execCommand ? document.execCommand('copy') : false;
      document.body.removeChild(temp);
      return Boolean(done);
    } catch (error) {
      return false;
    }
  }

  /** 从地址栏读取分享内容；没有或不合法时返回 null。 */
  function readShare() {
    const href = window.location && window.location.href;
    if (!href || typeof URL !== 'function') return null;

    let params;
    try {
      params = new URL(href).searchParams;
    } catch (error) {
      return null;
    }

    const text = decodeShare(params.get(SHARE_PARAM) || '');
    return text || null;
  }

  /* ---------- 最近一次使用的转盘 ---------- */

  /**
   * 只留一条「最近使用」。缓存的是内容本身，不含时长——
   * 时长属于设备偏好，跨设备同步没有意义。
   */
  function saveRecent(text) {
    const value = parseLines(text).join('\n');
    if (!value) return;

    // 与内置方案重复时既不再写，也刻意不删已有记录：
    // 用户只是点开面板再点「生成转盘」不该顺手抹掉上次的自定义转盘。
    if (PRESETS.some((preset) => preset.lines.join('\n') === value)) return;

    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ text: value, at: Date.now() })
      );
    } catch (error) {
      /* 隐私模式下写入失败，忽略即可 */
    }
  }

  function clearRecent() {
    try {
      localStorage.removeItem(STORE_KEY);
    } catch (error) {
      /* 同上 */
    }
  }

  function loadRecent() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data.text !== 'string') return null;

      const text = parseLines(data.text).join('\n');
      if (!text) return null;
      return { text, at: Number(data.at) || 0 };
    } catch (error) {
      return null;
    }
  }

  /** `今天 14:05` / `3-08 14:05`，用于「最近使用」卡片的标题。 */
  function formatRecentTime(timestamp) {
    if (!timestamp) return '最近使用';

    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '最近使用';

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    if (sameDay) return `今天 ${time}`;

    const sameYear = date.getFullYear() === now.getFullYear();
    const day = `${date.getMonth() + 1}-${pad(date.getDate())}`;
    return sameYear ? `${day} ${time}` : `${date.getFullYear()}-${day}`;
  }

  /** 卡片描述：首条内容 + 份数，过长时省略。 */
  function summarizeLines(lines) {
    const first = lines[0] || '';
    const head = first.length > 10 ? first.slice(0, 10) + '…' : first;
    const extra = lines.length > 1 ? ` 等 ${lines.length} 项` : '';
    return head + extra;
  }

  /* ---------- 事件绑定 ---------- */

  function bindEvents() {
    els.settingsBtn.addEventListener('click', openPanel);
    els.closeBtn.addEventListener('click', closePanel);
    els.scrim.addEventListener('click', closePanel);

    els.spinBtn.addEventListener('click', spin);

    // 只读输入框点一下就全选，方便手动复制
    els.shareUrl.addEventListener('click', () => {
      if (els.shareUrl.value) els.shareUrl.select();
    });

    els.copyBtn.addEventListener('click', async () => {
      const url = els.shareUrl.value;
      if (!url) return;
      const done = await copyText(url);
      hint(
        done ? '分享链接已复制，发给对方即可打开同一个转盘' : '复制失败，请手动选中链接复制',
        !done
      );
    });

    els.applyBtn.addEventListener('click', () => {
      if (state.spinning) return;
      els.duration.value = String(readDuration());
      state.durationSec = readDuration();
      if (!applyInput()) return;
      // 只有「确认生成」才写入最近使用，避免输入过程中的每次停顿都覆盖记录
      saveRecent(els.lines.value);
      saveDuration(state.durationSec);
      renderPresets();
      syncUrl();
      refreshShareField();
      closePanel();
    });

    els.presets.addEventListener('click', (event) => {
      const btn = event.target.closest('.preset');
      if (!btn) return;

      const entry = presetEntries()[Number(btn.dataset.index)];
      if (!entry) return;

      els.lines.value = entry.lines.join('\n');
      applyInput({ silent: true });
      if (entry.recent) saveRecent(entry.lines.join('\n'));
      renderPresets();
      syncUrl();
      refreshShareField();
      hint(`已载入「${entry.name}」· ${summaryText()}`);
    });

    // 输入时只刷新预览与面板里的链接，不碰地址栏：
    // 未确认的草稿不该把一长串 base64 顶到 URL 上。
    let previewTimer = 0;
    els.lines.addEventListener('input', () => {
      window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => {
        if (state.spinning) return;
        syncPresetActive();
        if (applyInput({ silent: true })) {
          hint(summaryText());
        } else {
          hint('请至少输入一行内容', true);
        }
        refreshShareField();
      }, 160);
    });

    els.duration.addEventListener('input', () => {
      const value = Number(els.duration.value);
      if (
        Number.isFinite(value) &&
        value >= MIN_DURATION &&
        value <= MAX_DURATION
      ) {
        state.durationSec = Math.round(value);
        hint(`转动时长 ${state.durationSec} 秒`);
      }
    });

    els.duration.addEventListener('blur', () => {
      els.duration.value = String(readDuration());
      state.durationSec = readDuration();
      saveDuration(state.durationSec);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closePanel();
        return;
      }
      if (event.key !== ' ' && event.code !== 'Space') return;
      if (isPanelOpen()) return;

      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'BUTTON') return;

      event.preventDefault();
      spin();
    });
  }

  /* ---------- Service Worker ---------- */

  /**
   * 注册 Service Worker，激活后提示「可离线使用」。
   *
   * 只有 http(s) 才能注册 SW：以 file:// 直接打开页面时浏览器会直接抛异常，
   * 所以这里先判断协议再尝试，避免控制台报无谓的错误。
   */
  function registerServiceWorker() {
    const nav = window.navigator;
    if (!nav || !('serviceWorker' in nav)) return;

    const protocol = window.location && window.location.protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return;

    const showBadge = () => {
      if (els.offlineBadge) els.offlineBadge.hidden = false;
    };

    window.addEventListener('load', async () => {
      try {
        const registration = await nav.serviceWorker.register('./sw.js', {
          scope: './',
        });

        // 已有处于激活状态的 SW 时，页面当下就能离线运行
        if (registration.active) {
          showBadge();
          return;
        }

        // 首次安装：等它接管后再生效
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'activated') showBadge();
          });
        });

        await nav.serviceWorker.ready;
        showBadge();
      } catch (error) {
        // 注册失败不影响主流程，只是失去离线能力
        console.warn('Service Worker 注册失败：', error);
      }
    });
  }

  /* ---------- 快捷方式入口 ---------- */

  /** 支持 manifest 快捷方式：./?action=spin 直接开始转动。 */
  function handleLaunchAction() {
    const href = window.location && window.location.href;
    if (!href || typeof URLSearchParams !== 'function') return;

    let params;
    try {
      params = new URLSearchParams(new URL(href).search);
    } catch (error) {
      return;
    }
    if (params.get('action') !== 'spin') return;

    // 让转盘先完成首帧绘制再转
    window.setTimeout(() => spin(), 320);
  }

  /* ---------- 初始化 ---------- */

  function init() {
    // 转盘内容的唯一来源是地址栏：带 ?w= 的链接还原分享内容，
    // 否则一律回到默认的骰子 1~6，不再自动恢复上一次的编辑。
    const shared = readShare();
    const text = shared || DEFAULT_LINES.join('\n');
    const duration = loadDuration();

    els.lines.value = text;
    els.duration.value = String(duration);
    state.durationSec = duration;

    renderPresets();
    updateSize();
    applyInput({ silent: true });
    hint(shared ? `已载入分享的转盘 · ${summaryText()}` : summaryText());
    refreshShareField();
    bindEvents();

    if ('ResizeObserver' in window) {
      new ResizeObserver(updateSize).observe(els.stage);
    } else {
      window.addEventListener('resize', updateSize);
    }
    window.addEventListener('orientationchange', () => {
      window.setTimeout(updateSize, 220);
    });

    registerServiceWorker();
    handleLaunchAction();
  }

  init();
})();
