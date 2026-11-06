/* ==========================================================================
   Picker Wheel · Service Worker
   --------------------------------------------------------------------------
   离线策略：应用外壳预缓存 + 导航请求网络优先、静态资源缓存优先。
   站点是纯静态的，除本文件外没有任何构建产物。
   ========================================================================== */

const VERSION = 'v1';
const SHELL_CACHE = `picker-shell-${VERSION}`;
const RUNTIME_CACHE = `picker-runtime-${VERSION}`;

/** 应用外壳：缺一不可，预缓存失败则整个安装失败。 */
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './favicon.svg',
  './favicon-16.png',
  './favicon-32.png',
  './favicon.ico',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

/* ---------- 安装：预缓存外壳 ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 逐个添加，避免单个资源失败导致整体回滚时难以定位
      await Promise.all(
        SHELL_ASSETS.map(async (url) => {
          const response = await fetch(new Request(url, { cache: 'reload' }));
          if (!response.ok) {
            throw new Error(`预缓存失败：${url} → ${response.status}`);
          }
          await cache.put(url, response);
        })
      );
      await self.skipWaiting();
    })()
  );
});

/* ---------- 激活：清理旧版本缓存 ---------- */

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      );
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })()
  );
});

/* ---------- 请求拦截 ---------- */

async function handleNavigation(event) {
  try {
    // 优先用预加载的响应，省一次往返
    const preload = await event.preloadResponse;
    if (preload) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('./index.html', preload.clone());
      return preload;
    }

    const response = await fetch(event.request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('./index.html', response.clone());
    }
    return response;
  } catch (error) {
    // 离线：无论原始 URL 带什么查询串，都回落到缓存的外壳
    const cache = await caches.open(SHELL_CACHE);
    const cached = (await cache.match('./index.html')) || (await cache.match('./'));
    if (cached) return cached;
    throw error;
  }
}

async function handleAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    const runtime = await caches.open(RUNTIME_CACHE);
    runtime.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 只接管同源请求，避免干扰第三方
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  event.respondWith(handleAsset(request));
});

/* ---------- 让页面可以主动查询版本 / 触发更新 ---------- */

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
