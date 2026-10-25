// ==UserScript==
// @name         V2EX 每日自动签到
// @namespace    https://github.com/nikoranger/tampermonkey_scripts/tree/main/v2ex_daily_checkin
// @version      0.1.2
// @description  访问 V2EX 时自动领取每日登录奖励；支持同日去重、失败冷却与手动检查
// @author       niko
// @license      MIT
// @match        https://v2ex.com/*
// @match        https://www.v2ex.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  const LOG_PREFIX = '[v2ex-daily-checkin]';
  const STATE_KEY = 'v2exDailyCheckin.state.v2';
  const SETTINGS_KEY = 'v2exDailyCheckin.settings.v1';
  const AUTO_DELAY_MS = 1200;
  const RETRY_COOLDOWN_MS = 2 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 15000;
  const RETRY_DELAY_MS = 1500;
  const AUTH_PATHS = new Set(['/signin', '/signup', '/forgot', '/reset']);
  const TERMINAL_STATUSES = new Set(['success', 'already']);
  const COOLDOWN_STATUSES = new Set(['error', 'unavailable']);
  const TOAST_HOST_ID = 'v2ex-daily-checkin-toast';

  const DEFAULT_SETTINGS = Object.freeze({
    autoCheck: true,
  });

  let settings = loadSettings();
  let state = loadState();
  let running = false;
  let autoTimer = 0;
  let toastTimer = 0;
  let menuIds = [];

  init();

  function init() {
    refreshMenus();
    scheduleAutoCheck();
  }

  function scheduleAutoCheck(delay = AUTO_DELAY_MS) {
    window.clearTimeout(autoTimer);
    autoTimer = 0;

    if (!settings.autoCheck || isAuthPage()) return;
    if (getLoginHint() === false) return;

    const today = shanghaiDateKey();
    if (state.date === today && TERMINAL_STATUSES.has(state.status)) return;
    if (
      state.date === today &&
      COOLDOWN_STATUSES.has(state.status) &&
      Date.now() - state.lastAttemptAt < RETRY_COOLDOWN_MS
    ) {
      return;
    }

    autoTimer = window.setTimeout(() => {
      autoTimer = 0;
      runCheckIn({ manual: false });
    }, delay);
  }

  async function runCheckIn({ manual }) {
    if (running) {
      if (manual) showToast('正在检查签到状态，请稍候。', 'info', 4000);
      return;
    }

    if (!manual && (!settings.autoCheck || shouldSkipAutoCheck())) return;

    window.clearTimeout(autoTimer);
    autoTimer = 0;
    running = true;

    if (manual) showToast('正在检查今日签到状态…', 'info', 0);

    try {
      let result = await checkIn();
      if (result.status === 'error' && result.retryable) {
        await sleep(RETRY_DELAY_MS);
        result = await checkIn();
      }
      saveResult(result);

      const kind = result.status === 'success' || result.status === 'already'
        ? 'success'
        : result.status === 'error'
          ? 'error'
          : result.status === 'logged-out' || result.status === 'unavailable'
            ? 'warn'
            : 'info';

      showToast(result.message, kind, kind === 'error' ? 8000 : 6000);
      if (result.status === 'error') warn(result.message);
    } catch (error) {
      const message = `自动签到失败：${describeError(error)}`;
      saveResult({ status: 'error', message });
      showToast(message, 'error', 8000);
      warn(message, error);
    } finally {
      running = false;
    }
  }

  function shouldSkipAutoCheck() {
    if (isAuthPage() || getLoginHint() === false) return true;

    const today = shanghaiDateKey();
    if (state.date === today && TERMINAL_STATUSES.has(state.status)) return true;
    if (
      state.date === today &&
      COOLDOWN_STATUSES.has(state.status) &&
      Date.now() - state.lastAttemptAt < RETRY_COOLDOWN_MS
    ) {
      return true;
    }

    return false;
  }

  async function checkIn() {
    let dailyResponse;
    try {
      dailyResponse = await fetchWithTimeout('/mission/daily', {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
    } catch (error) {
      return {
        status: 'error',
        retryable: true,
        message: `无法访问每日任务页：${describeError(error)}`,
      };
    }

    const dailyHtml = await safeResponseText(dailyResponse);
    if (isLoggedOutPage(dailyResponse, dailyHtml)) {
      return {
        status: 'logged-out',
        message: '请先登录 V2EX；登录后再次访问即可自动签到。',
      };
    }

    if (!dailyResponse.ok) {
      return {
        status: 'error',
        retryable: dailyResponse.status >= 500,
        message: `每日任务页返回 HTTP ${dailyResponse.status}。`,
      };
    }

    if (getResponsePathname(dailyResponse) !== '/mission/daily') {
      return {
        status: 'error',
        message: '每日任务页发生了意外跳转，请稍后重试。',
      };
    }

    if (!isDailyMissionPage(dailyHtml)) {
      return {
        status: 'unavailable',
        message: '未能识别每日任务页，页面可能改版或暂时不可用。',
      };
    }

    const redeemUrl = extractRedeemUrl(dailyHtml);
    if (!redeemUrl) {
      return {
        status: 'already',
        message: detectAlreadyCheckedIn(dailyHtml)
          ? '今日已经签到，无需重复领取。'
          : '今日没有待领取的登录奖励，可能已经签到。',
      };
    }

    let redeemResponse;
    try {
      redeemResponse = await fetchWithTimeout(redeemUrl, {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
    } catch (error) {
      return {
        status: 'error',
        retryable: true,
        message: `领取请求未完成：${describeError(error)}`,
      };
    }

    const redeemHtml = await safeResponseText(redeemResponse);
    if (isLoggedOutPage(redeemResponse, redeemHtml)) {
      return {
        status: 'logged-out',
        message: '登录状态已失效，请重新登录后再试。',
      };
    }

    if (!redeemResponse.ok) {
      return {
        status: 'error',
        retryable: redeemResponse.status >= 500,
        message: `领取接口返回 HTTP ${redeemResponse.status}。`,
      };
    }

    if (detectRedeemFailure(redeemHtml)) {
      return {
        status: 'error',
        message: '领取请求未成功，任务页可能要求重新登录或人工操作。',
      };
    }

    const verification = await verifyCheckIn();
    if (verification === 'redeemed') {
      return { status: 'success', message: '签到成功，今日登录奖励已领取。' };
    }
    if (verification === 'logged-out') {
      return {
        status: 'logged-out',
        message: '登录状态已失效，请重新登录后再试。',
      };
    }
    if (verification === 'unknown' && detectRedeemSuccess(redeemHtml)) {
      return { status: 'success', message: '签到成功，今日登录奖励已领取。' };
    }

    return {
      status: 'error',
      retryable: true,
      message: '领取请求已发送，但服务器尚未确认结果，请打开任务页查看。',
    };
  }

  async function verifyCheckIn() {
    try {
      const response = await fetchWithTimeout('/mission/daily', {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      const html = await safeResponseText(response);

      if (isLoggedOutPage(response, html)) return 'logged-out';
      if (!response.ok) return 'unknown';
      if (getResponsePathname(response) !== '/mission/daily') return 'unknown';
      if (!extractRedeemUrl(html) && isDailyMissionPage(html)) return 'redeemed';
      return 'pending';
    } catch (error) {
      warn('复核签到结果失败', error);
      return 'unknown';
    }
  }

  function extractRedeemUrl(html) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(html, 'text/html');
    } catch (error) {
      warn('解析每日任务页失败', error);
      return null;
    }

    // 旧版任务页使用领取链接。
    for (const link of doc.querySelectorAll('a[href]')) {
      const redeemUrl = normalizeRedeemUrl(link.getAttribute('href'));
      if (redeemUrl) return redeemUrl;
    }

    // 新版任务页改用按钮和 onclick 跳转。
    for (const element of doc.querySelectorAll('[onclick]')) {
      const onclick = element.getAttribute('onclick') || '';
      const match = onclick.match(/\/mission\/daily\/redeem\?[^'"\s;<>\\]+/);
      if (!match) continue;

      const redeemUrl = normalizeRedeemUrl(match[0]);
      if (redeemUrl) return redeemUrl;
    }

    return null;
  }

  function normalizeRedeemUrl(candidate) {
    try {
      const url = new URL(candidate, location.origin);
      const isSameOrigin = url.origin === location.origin;
      const isV2exHttps = url.protocol === 'https:' &&
        (url.hostname === 'v2ex.com' || url.hostname === 'www.v2ex.com');
      if (!isSameOrigin && !isV2exHttps) return null;
      if (url.pathname !== '/mission/daily/redeem') return null;
      if (!url.searchParams.get('once')) return null;

      const safeUrl = new URL('/mission/daily/redeem', location.origin);
      safeUrl.search = url.search;
      return safeUrl.href;
    } catch (error) {
      return null;
    }
  }

  function isLoggedOutPage(response, html) {
    if (getResponsePathname(response) === '/signin') return true;

    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (doc.querySelector('form[action="/signin"], form[action^="/signin?"]')) return true;
      const problem = doc.querySelector('.problem, .alert, .error');
      return Boolean(problem && /请先登录|登录后(?:再|才能)/.test(problem.textContent || ''));
    } catch (error) {
      return false;
    }
  }

  function getResponsePathname(response) {
    try {
      return new URL(response.url || '/', location.origin).pathname;
    } catch (error) {
      return '';
    }
  }

  function isDailyMissionPage(html) {
    return /每日(?:登录)?奖励|每日任务|登录奖励/.test(htmlToText(html));
  }

  function detectAlreadyCheckedIn(html) {
    const text = htmlToText(html);
    if (!text) return false;

    return (
      /(?:今日|今天).{0,24}(?:已经|已).{0,12}(?:领取|领过|签到)/.test(text) ||
      /(?:已经|已).{0,12}(?:领取|领过).{0,24}(?:今日|今天).{0,16}(?:奖励|签到)/.test(text) ||
      /不能重复领取/.test(text)
    );
  }

  function detectRedeemSuccess(html) {
    const text = htmlToText(html);
    if (!text) return false;

    return (
      /(?:领取|签到)成功/.test(text) ||
      /(?:今日|今天).{0,24}(?:已经|已).{0,12}(?:领取|领过|签到)/.test(text) ||
      /你获得了\s*\d+\s*个?\s*铜币/.test(text) ||
      /^(?:ok|success)$/i.test(text.trim())
    );
  }

  function detectRedeemFailure(html) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(html, 'text/html');
    } catch (error) {
      return false;
    }

    const problem = doc.querySelector('.problem, .alert, .error');
    if (!problem) return false;

    const text = normalizeText(problem.textContent);
    return /(?:领取|签到)失败|无法领取|不能领取|请求无效|操作过于频繁|验证码|请先登录|登录后(?:再|才能)/.test(text);
  }

  function htmlToText(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const element of doc.querySelectorAll('script, style, noscript')) element.remove();
      return normalizeText(doc.body ? doc.body.textContent : '');
    } catch (error) {
      return '';
    }
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function getLoginHint() {
    const top = document.querySelector('#Top') || document.querySelector('.site-nav');
    if (top) {
      const links = Array.from(top.querySelectorAll('a[href]'));
      if (links.some((link) => hrefPathname(link.getAttribute('href')) === '/signin')) return false;
      if (links.some((link) => {
        const pathname = hrefPathname(link.getAttribute('href'));
        return pathname === '/notifications' ||
          pathname.startsWith('/notifications/') ||
          pathname === '/settings' ||
          pathname === '/logout' ||
          pathname.startsWith('/member/');
      })) {
        return true;
      }
    }

    if (document.querySelector('form[action="/signin"], form[action^="/signin?"]')) return false;
    return null;
  }

  function hrefPathname(href) {
    try {
      return new URL(href, location.origin).pathname;
    } catch (error) {
      return '';
    }
  }

  function isAuthPage() {
    return AUTH_PATHS.has(location.pathname);
  }

  async function fetchWithTimeout(input, init) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(input, Object.assign({}, init, { signal: controller.signal }));
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function safeResponseText(response) {
    try {
      return await response.text();
    } catch (error) {
      warn('读取响应内容失败', error);
      return '';
    }
  }

  function describeError(error) {
    if (error && error.name === 'AbortError') return '请求超时';
    if (error && error.message) return error.message;
    return '网络异常';
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function saveResult(result) {
    state = {
      date: shanghaiDateKey(),
      status: result.status,
      message: result.message,
      lastAttemptAt: Date.now(),
    };
    gmSet(STATE_KEY, state);
  }

  function loadState() {
    const stored = gmGet(STATE_KEY, {});
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return emptyState();
    return {
      date: typeof stored.date === 'string' ? stored.date : '',
      status: typeof stored.status === 'string' ? stored.status : '',
      message: typeof stored.message === 'string' ? stored.message : '',
      lastAttemptAt: Number.isFinite(stored.lastAttemptAt) ? stored.lastAttemptAt : 0,
    };
  }

  function emptyState() {
    return { date: '', status: '', message: '', lastAttemptAt: 0 };
  }

  function loadSettings() {
    const stored = gmGet(SETTINGS_KEY, {});
    const result = Object.assign({}, DEFAULT_SETTINGS);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      if (typeof stored.autoCheck === 'boolean') result.autoCheck = stored.autoCheck;
    }
    return result;
  }

  function saveSettings() {
    gmSet(SETTINGS_KEY, settings);
  }

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
    } catch (error) {
      warn('读取油猴存储失败', error);
    }

    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }
    } catch (error) {
      warn('写入油猴存储失败', error);
    }

    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      warn('写入本地存储失败', error);
    }
  }

  function refreshMenus() {
    unregisterMenus();
    registerMenu(`自动签到：${settings.autoCheck ? '开' : '关'}（点击切换）`, toggleAutoCheck);
    registerMenu('立即检查并领取今日签到', () => runCheckIn({ manual: true }));
    registerMenu('查看今日签到状态', showStatus);
  }

  function registerMenu(label, handler) {
    try {
      if (typeof GM_registerMenuCommand !== 'function') return;
      const id = GM_registerMenuCommand(label, handler);
      if (id !== undefined && id !== null) menuIds.push(id);
    } catch (error) {
      warn('注册油猴菜单失败', error);
    }
  }

  function unregisterMenus() {
    for (const id of menuIds) {
      try {
        if (typeof GM_unregisterMenuCommand === 'function') {
          GM_unregisterMenuCommand(id);
        }
      } catch (error) {
        warn('移除油猴菜单失败', error);
      }
    }
    menuIds = [];
  }

  function toggleAutoCheck() {
    settings.autoCheck = !settings.autoCheck;
    saveSettings();
    refreshMenus();
    window.clearTimeout(autoTimer);
    autoTimer = 0;

    if (settings.autoCheck) {
      showToast('自动签到已开启。', 'success', 3500);
      scheduleAutoCheck(300);
    } else {
      showToast('自动签到已关闭，仍可从油猴菜单手动检查。', 'info', 4500);
    }
  }

  function showStatus() {
    if (getLoginHint() === false) {
      showToast('当前未登录 V2EX；登录后再次访问页面即可自动签到。', 'warn', 6500);
      return;
    }

    if (state.date !== shanghaiDateKey()) {
      showToast(
        settings.autoCheck ? '今日尚未检查签到。' : '自动签到已关闭，今日尚未检查。',
        'info',
        5500
      );
      return;
    }

    const time = formatTime(state.lastAttemptAt);
    const message = state.message || statusLabel(state.status);
    showToast(`${message}${time ? `（检查于 ${time}）` : ''}`, statusKind(state.status), 6500);
  }

  function statusLabel(status) {
    switch (status) {
      case 'success':
        return '今日签到成功。';
      case 'already':
        return '今日已经签到。';
      case 'logged-out':
        return '当前登录状态无效，请重新登录。';
      case 'error':
        return '上次检查失败。';
      case 'unavailable':
        return '未找到今日领取入口。';
      default:
        return '今日尚未检查签到。';
    }
  }

  function statusKind(status) {
    if (status === 'success' || status === 'already') return 'success';
    if (status === 'error') return 'error';
    if (status === 'logged-out' || status === 'unavailable') return 'warn';
    return 'info';
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(timestamp));
    } catch (error) {
      return '';
    }
  }

  function shanghaiDateKey(date = new Date()) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);
      const values = {};
      for (const part of parts) values[part.type] = part.value;
      return `${values.year}-${values.month}-${values.day}`;
    } catch (error) {
      return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    }
  }

  function showToast(message, kind = 'info', duration = 5000) {
    let host = document.getElementById(TOAST_HOST_ID);
    if (host && !host.shadowRoot) {
      host.remove();
      host = null;
    }
    if (!host) {
      host = document.createElement('div');
      host.id = TOAST_HOST_ID;
      host.style.cssText = [
        'all: initial',
        'position: fixed',
        'right: 18px',
        'bottom: 18px',
        'z-index: 2147483647',
        'display: block',
      ].join(';');
      (document.body || document.documentElement).appendChild(host);

      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          :host { all: initial; }
          .card {
            --accent: #3a8f5a;
            box-sizing: border-box;
            width: min(380px, calc(100vw - 28px));
            display: grid;
            grid-template-columns: 8px minmax(0, 1fr) auto;
            gap: 12px;
            align-items: start;
            padding: 13px 14px;
            border: 1px solid rgba(255, 255, 255, .12);
            border-radius: 12px;
            background: #202124;
            color: #f5f5f5;
            box-shadow: 0 12px 38px rgba(0, 0, 0, .3);
            font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
          }
          .card[data-kind="warn"] { --accent: #d99a32; }
          .card[data-kind="error"] { --accent: #d95d5d; }
          .dot {
            width: 8px;
            height: 8px;
            margin-top: 6px;
            border-radius: 50%;
            background: var(--accent);
            box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
          }
          .body { min-width: 0; }
          .title {
            display: block;
            margin-bottom: 2px;
            color: #fff;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: .04em;
          }
          .message {
            display: block;
            overflow-wrap: anywhere;
            color: #d9d9d9;
          }
          .actions {
            display: flex;
            align-items: center;
            gap: 7px;
            padding-top: 1px;
          }
          .open {
            color: #a8d9b8;
            text-decoration: none;
            white-space: nowrap;
          }
          .open:hover { text-decoration: underline; }
          .close {
            appearance: none;
            width: 24px;
            height: 24px;
            padding: 0;
            border: 0;
            border-radius: 6px;
            background: transparent;
            color: #a9a9a9;
            cursor: pointer;
            font: 18px/24px sans-serif;
          }
          .close:hover { background: rgba(255, 255, 255, .08); color: #fff; }
          @media (max-width: 520px) {
            .card { width: calc(100vw - 28px); }
          }
        </style>
        <section class="card" role="status" aria-live="polite" data-kind="info">
          <span class="dot" aria-hidden="true"></span>
          <div class="body">
            <strong class="title">V2EX 自动签到</strong>
            <span class="message"></span>
          </div>
          <div class="actions">
            <a class="open" target="_blank" rel="noopener noreferrer">任务页</a>
            <button class="close" type="button" aria-label="关闭通知">×</button>
          </div>
        </section>
      `;
      root.querySelector('.close').addEventListener('click', (event) => {
        event.stopPropagation();
        hideToast();
      });
    }

    const root = host.shadowRoot;
    const card = root.querySelector('.card');
    const messageElement = root.querySelector('.message');
    const action = root.querySelector('.open');
    card.dataset.kind = kind;
    messageElement.textContent = message;
    action.href = new URL('/mission/daily', location.origin).href;

    window.clearTimeout(toastTimer);
    host.style.display = 'block';
    if (duration > 0) {
      toastTimer = window.setTimeout(hideToast, duration);
    }
  }

  function hideToast() {
    const host = document.getElementById(TOAST_HOST_ID);
    if (host) host.style.display = 'none';
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }
})();
