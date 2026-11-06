/* ==========================================================================
   Picker Wheel · 大转盘
   纯静态、零依赖。Canvas 绘制 + rAF 缓动旋转。
   ========================================================================== */

(() => {
  'use strict';

  /* ---------- 常量 ---------- */

  const MIN_DURATION = 5;
  const MAX_DURATION = 600;
  const STORE_KEY = 'picker-wheel/v1';

  const DEFAULT_LINES = ['1', '2', '3', '4', '5', '6'];

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

  const PRESETS = [
    { name: '摇骰子', desc: '1 ~ 6', lines: ['1', '2', '3', '4', '5', '6'] },
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
  };

  const ctx = els.canvas.getContext('2d');

  const state = {
    segments: [],
    rotation: 0,
    spinning: false,
    durationSec: MIN_DURATION,
    size: 320,
    dpr: 1,
    rawText: '',
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

    state.rawText = text.trim();
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

  function renderPresets() {
    const frag = document.createDocumentFragment();
    PRESETS.forEach((preset, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset';
      btn.dataset.index = String(index);

      const title = document.createElement('b');
      title.textContent = preset.name;

      const desc = document.createElement('span');
      desc.textContent = preset.desc;

      btn.append(title, desc);
      frag.appendChild(btn);
    });
    els.presets.replaceChildren(frag);
  }

  function syncPresetActive() {
    const lines = parseLines(els.lines.value);
    Array.from(els.presets.children).forEach((btn, index) => {
      const preset = PRESETS[index];
      const same =
        preset.lines.length === lines.length &&
        preset.lines.every((item, i) => item === lines[i]);
      btn.classList.toggle('is-active', same);
    });
  }

  /* ---------- 本地存储 ---------- */

  function save() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          text: els.lines.value,
          duration: readDuration(),
        })
      );
    } catch (error) {
      /* 隐私模式下写入失败，忽略即可 */
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data.text !== 'string') return null;
      return {
        text: data.text,
        duration: clamp(
          Math.round(Number(data.duration) || MIN_DURATION),
          MIN_DURATION,
          MAX_DURATION
        ),
      };
    } catch (error) {
      return null;
    }
  }

  /* ---------- 事件绑定 ---------- */

  function bindEvents() {
    els.settingsBtn.addEventListener('click', openPanel);
    els.closeBtn.addEventListener('click', closePanel);
    els.scrim.addEventListener('click', closePanel);

    els.spinBtn.addEventListener('click', spin);

    els.applyBtn.addEventListener('click', () => {
      if (state.spinning) return;
      els.duration.value = String(readDuration());
      state.durationSec = readDuration();
      if (!applyInput()) return;
      save();
      closePanel();
    });

    els.presets.addEventListener('click', (event) => {
      const btn = event.target.closest('.preset');
      if (!btn) return;
      const preset = PRESETS[Number(btn.dataset.index)];
      if (!preset) return;

      els.lines.value = preset.lines.join('\n');
      applyInput({ silent: true });
      syncPresetActive();
      save();
      hint(`已载入「${preset.name}」· ${summaryText()}`);
    });

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
        save();
        hint(`转动时长 ${state.durationSec} 秒`);
      }
    });

    els.duration.addEventListener('blur', () => {
      els.duration.value = String(readDuration());
      state.durationSec = readDuration();
      save();
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
    renderPresets();

    const saved = load();
    if (saved) {
      els.lines.value = saved.text;
      els.duration.value = String(saved.duration);
      state.durationSec = saved.duration;
    } else {
      els.lines.value = DEFAULT_LINES.join('\n');
      els.duration.value = String(MIN_DURATION);
      state.durationSec = MIN_DURATION;
    }

    syncPresetActive();
    updateSize();
    applyInput({ silent: true });
    hint(summaryText());
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
