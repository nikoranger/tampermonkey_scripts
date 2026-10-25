// ==UserScript==
// @name         B 站游客播放增强（仅公开内容）
// @namespace    https://github.com/nikoranger/tampermonkey_scripts/tree/main/bilibili_guest_view
// @version      0.2.0
// @description  自动关闭登录弹层、隐藏登录与 App 提示并恢复页面滚动；仅优化无需登录即可访问的公开内容，不绕过登录、会员或付费权限
// @author       niko
// @license      MIT
// @match        https://www.bilibili.com/*
// @match        https://m.bilibili.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// ==/UserScript==

/*
 * 功能边界
 * --------
 * 本脚本只处理页面界面：自动关闭登录弹层、隐藏“登录后更精彩”等提示，并在关闭弹层后解除页面滚动锁定。
 * 可选隐藏 B 站网页中的 App 下载、打开 App 和“用手机观看”推广提示。
 * 它不会修改 Cookie、请求参数、播放器鉴权、清晰度列表或视频地址，也不会绕过会员、付费、DRM 或服务端登录校验。
 * 因此，真正由服务端限制为“必须登录”的内容仍会被拦截；匿名可访问的公开内容不受影响。
 *
 * 如果用户主动点击页面上的“登录”入口，下一个登录弹层会被标记为用户主动打开并保持可见，避免影响正常登录。
 * 对未知登录弹层提供基于 ARIA、文本和几何位置的通用兜底识别。
 */

(function () {
  'use strict';

  const host = location.hostname;
  if (host !== 'www.bilibili.com' && host !== 'm.bilibili.com') return;

  const LOG_PREFIX = '[bili-guest-view]';
  const SETTINGS_KEY = 'biliGuestView.settings.v1';
  const STYLE_ID = 'bili-guest-view-style';
  const TOAST_ID = 'bili-guest-view-toast';
  const USER_LOGIN_INTENT_MS = 10000;
  const DISMISS_RETRY_MS = 250;
  const HIDDEN_MODAL_ATTR = 'data-bili-guest-hidden';
  const PREV_DISPLAY_ATTR = 'data-bili-guest-prev-display';

  const DEFAULT_SETTINGS = Object.freeze({
    dismissLoginModal: true,
    hideLoginPrompts: true,
    hideAppPrompts: false,
    restoreScroll: true,
    debug: false,
  });

  const KNOWN_MODAL_SELECTORS = [
    '.bili-mini-mask',
    '#login-container',
    '.bili-login-dialog-mask',
    '.bili-login-dialog',
    '.bili-login-mask',
    '.login-mask',
  ];

  // 未知弹层只在具备登录语义和足够大的遮罩/对话框尺寸时才会被处理，避免误关普通弹窗。
  const GENERIC_MODAL_SELECTORS = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[class*="login" i][class*="dialog" i]',
    '[class*="login" i][class*="mask" i]',
    '[class*="login" i][class*="modal" i]',
    '[class*="signin" i][class*="dialog" i]',
  ];

  const MODAL_SELECTORS = [...KNOWN_MODAL_SELECTORS, ...GENERIC_MODAL_SELECTORS];
  const LOGIN_DIALOG_TEXT = /(扫码登录|扫描二维码登录|手机号登录|短信登录|密码登录|验证码登录|账号登录|登录后你可以|登录\s*[/／]\s*注册|请(?:先)?登录|sign\s*in|log\s*in|create\s*account)/i;

  const CLOSE_BUTTON_SELECTORS = [
    '.bili-mini-close-icon',
    '[class*="login-close"]',
    '[class*="close-icon"]',
    '[class*="close-btn"]',
    '.van-dialog__close',
    '.bui-guanbi',
    'button.close',
    '.close',
    'button[aria-label*="关闭"]',
    '[role="button"][aria-label*="关闭"]',
    '[title*="关闭"]',
    'button[aria-label*="close" i]',
    '[role="button"][aria-label*="close" i]',
    '[title*="close" i]',
  ];

  const LOGIN_TRIGGER_SELECTORS = [
    'a[href*="passport.bilibili.com"]',
    '[class*="header-login" i]',
    '[class*="header-avatar-unlogin" i]',
    '[class*="login-entry" i]',
    '[class*="login-button" i]',
    '.face .login',
    '.login-btn',
  ];

  // 只隐藏明确的登录提示，不隐藏导航栏的登录入口，避免用户想主动登录时找不到按钮。
  const STYLE_TEXT = `
    html[data-bili-guest-hide-prompts="1"] .need-login-tips,
    html[data-bili-guest-hide-prompts="1"] .bpx-player-login-tip,
    html[data-bili-guest-hide-prompts="1"] .bpx-player-unlogin-tip,
    html[data-bili-guest-hide-prompts="1"] .login-panel-popover,
    html[data-bili-guest-hide-prompts="1"] .right-entry__item-unlogin-panel,
    html[data-bili-guest-hide-prompts="1"] .lt-row,
    html[data-bili-guest-hide-prompts="1"] [class*="login-tip" i],
    html[data-bili-guest-hide-prompts="1"] [class*="unlogin-tip" i],
    html[data-bili-guest-hide-prompts="1"] [class*="login-prompt" i] {
      display: none !important;
    }

    html[data-bili-guest-hide-app="1"] .m-nav-openapp,
    html[data-bili-guest-hide-app="1"] .m-video-main-launchapp,
    html[data-bili-guest-hide-app="1"] .desktop-download-tip,
    html[data-bili-guest-hide-app="1"] .app-watch-exp,
    html[data-bili-guest-hide-app="1"] .fe-ui-open-app-btn {
      display: none !important;
    }
  `;

  let settings = loadSettings();
  let observer = null;
  let styleElement = null;
  let scanTimer = 0;
  let started = false;
  let userLoginIntentUntil = 0;
  let toastTimer = 0;
  const pendingRoots = new Set();
  const lastDismissedAt = new WeakMap();
  const userLoginModals = new WeakSet();
  const menuIds = [];

  function loadSettings() {
    let stored = {};
    try {
      const value = GM_getValue(SETTINGS_KEY, {});
      if (value && typeof value === 'object' && !Array.isArray(value)) stored = value;
    } catch (error) {
      warn('读取设置失败', error);
    }
    return Object.assign({}, DEFAULT_SETTINGS, stored);
  }

  function saveSettings() {
    try {
      GM_setValue(SETTINGS_KEY, settings);
    } catch (error) {
      warn('保存设置失败', error);
    }
  }

  function debug(...args) {
    if (settings.debug) console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function onOff(value) {
    return value ? '开' : '关';
  }

  function registerMenu(label, handler) {
    try {
      const id = GM_registerMenuCommand(label, handler);
      if (id !== undefined && id !== null) menuIds.push(id);
    } catch (error) {
      warn('注册菜单失败', error);
    }
  }

  function refreshMenus() {
    while (menuIds.length) {
      const id = menuIds.pop();
      try {
        if (typeof GM_unregisterMenuCommand === 'function') GM_unregisterMenuCommand(id);
      } catch (error) {}
    }

    registerMenu('自动关闭登录弹层：' + onOff(settings.dismissLoginModal), () => {
      settings.dismissLoginModal = !settings.dismissLoginModal;
      saveSettings();
      refreshMenus();
      if (settings.dismissLoginModal) scanDocument();
      toast('自动关闭登录弹层已' + (settings.dismissLoginModal ? '开启' : '关闭'));
    });

    registerMenu('隐藏登录提示：' + onOff(settings.hideLoginPrompts), () => {
      settings.hideLoginPrompts = !settings.hideLoginPrompts;
      saveSettings();
      applyUiState();
      refreshMenus();
      toast('登录提示已' + (settings.hideLoginPrompts ? '隐藏' : '显示'));
    });

    registerMenu('隐藏 App 下载提示：' + onOff(settings.hideAppPrompts), () => {
      settings.hideAppPrompts = !settings.hideAppPrompts;
      saveSettings();
      applyUiState();
      refreshMenus();
      toast('App 下载提示已' + (settings.hideAppPrompts ? '隐藏' : '显示'));
    });

    registerMenu('关闭弹层后恢复滚动：' + onOff(settings.restoreScroll), () => {
      settings.restoreScroll = !settings.restoreScroll;
      saveSettings();
      refreshMenus();
      toast('关闭弹层后的滚动恢复已' + (settings.restoreScroll ? '开启' : '关闭'));
    });

    registerMenu('立即关闭当前登录弹层', () => {
      userLoginIntentUntil = 0;
      const closed = scanDocument(true);
      toast(closed ? '已关闭当前登录弹层' : '当前页面没有找到登录弹层');
    });

    registerMenu('检测当前页面登录弹层', () => {
      const modals = collectVisibleModals(document);
      if (!modals.length) {
        console.info(LOG_PREFIX, '未检测到登录弹层');
        toast('未检测到登录弹层');
        return;
      }
      const report = modals.map(describeModal);
      console.info(LOG_PREFIX, '登录弹层检测结果', report);
      toast('检测到 ' + modals.length + ' 个登录弹层，详情见控制台');
    });

    registerMenu('调试日志：' + onOff(settings.debug), () => {
      settings.debug = !settings.debug;
      saveSettings();
      refreshMenus();
      toast('调试日志已' + (settings.debug ? '开启' : '关闭'));
    });
  }

  function toast(message) {
    try {
      if (!document.documentElement) return;
      let element = document.getElementById(TOAST_ID);
      if (!element) {
        element = document.createElement('div');
        element.id = TOAST_ID;
        element.style.cssText = [
          'position:fixed',
          'right:16px',
          'bottom:16px',
          'z-index:2147483647',
          'max-width:320px',
          'padding:8px 12px',
          'background:rgba(20,20,20,.88)',
          'color:#fff',
          'font:12px/1.45 system-ui,-apple-system,sans-serif',
          'border-radius:6px',
          'box-shadow:0 4px 16px rgba(0,0,0,.25)',
          'pointer-events:none',
          'opacity:0',
          'transition:opacity .2s',
        ].join(';');
        document.documentElement.appendChild(element);
      }
      element.textContent = '[游客增强] ' + message;
      element.style.opacity = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        if (element) element.style.opacity = '0';
      }, 2200);
    } catch (error) {}
  }

  function injectStyle() {
    if (styleElement && styleElement.isConnected) return;
    styleElement = document.getElementById(STYLE_ID);
    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.id = STYLE_ID;
      styleElement.textContent = STYLE_TEXT;
      (document.head || document.documentElement).appendChild(styleElement);
    }
  }

  function applyUiState() {
    const root = document.documentElement;
    if (!root) return;
    root.dataset.biliGuestView = '1';
    root.dataset.biliGuestHidePrompts = settings.hideLoginPrompts ? '1' : '0';
    root.dataset.biliGuestHideApp = settings.hideAppPrompts ? '1' : '0';
  }

  function addMatchingElements(found, root, selectors) {
    if (!root) return;
    const selectorGroup = selectors.join(',');

    if (root instanceof Element) {
      try {
        if (root.matches(selectorGroup)) found.add(root);
        const closest = root.closest(selectorGroup);
        if (closest) found.add(closest);
      } catch (error) {}
    }

    if (typeof root.querySelectorAll !== 'function') return;
    try {
      root.querySelectorAll(selectorGroup).forEach((element) => found.add(element));
    } catch (error) {}
  }

  function elementMatchesSelector(element, selector) {
    try { return element instanceof Element && element.matches(selector); }
    catch (error) { return false; }
  }

  function looksLikeLoginModal(modal) {
    if (!(modal instanceof Element) || !modal.isConnected) return false;
    if (KNOWN_MODAL_SELECTORS.some((selector) => elementMatchesSelector(modal, selector))) return true;
    if (!GENERIC_MODAL_SELECTORS.some((selector) => elementMatchesSelector(modal, selector))) return false;

    const text = (modal.innerText || modal.textContent || '').trim().slice(0, 5000);
    if (!LOGIN_DIALOG_TEXT.test(text)) return false;

    let rect;
    let style;
    try {
      rect = modal.getBoundingClientRect();
      style = window.getComputedStyle(modal);
    } catch (error) {
      return false;
    }

    if (style.display === 'none' || style.visibility === 'hidden' || rect.width < 180 || rect.height < 120) {
      return false;
    }

    const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
    const areaRatio = (rect.width * rect.height) / viewportArea;
    const fixedLike = style.position === 'fixed' && rect.width >= Math.min(window.innerWidth * 0.45, 360);
    const dialogSized = rect.width >= 360 && rect.height >= 220;
    const elevated = style.position !== 'static' || Number.parseInt(style.zIndex, 10) >= 100;
    return areaRatio >= 0.04 || fixedLike || (dialogSized && elevated);
  }

  function collectVisibleModals(...roots) {
    const found = new Set();
    for (const root of roots) addMatchingElements(found, root, MODAL_SELECTORS);
    return [...found].filter(looksLikeLoginModal);
  }

  function restoredModalStyle(modal) {
    if (!(modal instanceof Element)) return;
    const previousDisplay = modal.getAttribute(PREV_DISPLAY_ATTR) || '';
    modal.style.removeProperty('display');
    if (previousDisplay) modal.style.display = previousDisplay;
    modal.removeAttribute(PREV_DISPLAY_ATTR);
    modal.removeAttribute(HIDDEN_MODAL_ATTR);
  }

  function restoreGuestHiddenModals() {
    let restored = 0;
    for (const modal of document.querySelectorAll(`[${HIDDEN_MODAL_ATTR}="1"]`)) {
      restoredModalStyle(modal);
      restored += 1;
    }
    if (restored) debug('已恢复被临时隐藏的登录弹层', restored);
  }

  function markUserLoginIntent(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const trigger = target.closest(LOGIN_TRIGGER_SELECTORS.join(','));
    if (!trigger) return;

    userLoginIntentUntil = Date.now() + USER_LOGIN_INTENT_MS;
    restoreGuestHiddenModals();
    debug('检测到用户主动登录操作，将保留下一个登录弹层', trigger);
  }

  function isVisibleElement(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    try {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    } catch (error) {
      return false;
    }
  }

  function findCloseButton(modal) {
    const candidates = new Set();
    for (const selector of CLOSE_BUTTON_SELECTORS) {
      try {
        if (modal.matches(selector)) candidates.add(modal);
        modal.querySelectorAll(selector).forEach((element) => candidates.add(element));
      } catch (error) {}
    }
    return [...candidates].find(isVisibleElement) || [...candidates][0] || null;
  }

  function restorePageScroll() {
    if (!settings.restoreScroll || !document.body) return;

    let changed = false;
    for (const element of [document.documentElement, document.body]) {
      if (!element) continue;
      if (element.style.overflow === 'hidden') {
        element.style.removeProperty('overflow');
        changed = true;
      }
      if (element.style.overflowY === 'hidden') {
        element.style.removeProperty('overflow-y');
        changed = true;
      }
    }

    if (changed) debug('已解除页面滚动锁定');
  }

  function hideModalFallback(modal) {
    if (!modal || !modal.isConnected) return;
    try {
      if (!modal.hasAttribute(HIDDEN_MODAL_ATTR)) {
        modal.setAttribute(PREV_DISPLAY_ATTR, modal.style.display || '');
      }
      modal.setAttribute(HIDDEN_MODAL_ATTR, '1');
      modal.style.setProperty('display', 'none', 'important');
    } catch (error) {}
  }

  function dismissModal(modal, force = false) {
    if ((!settings.dismissLoginModal && !force) || !modal || !modal.isConnected) return false;

    if (!force) {
      if (userLoginModals.has(modal)) {
        debug('该登录弹层由用户主动打开，保持可见');
        return false;
      }
      if (Date.now() < userLoginIntentUntil) {
        userLoginModals.add(modal);
        userLoginIntentUntil = 0;
        debug('保留用户主动打开的登录弹层', modal.className || modal.id || modal.tagName);
        return false;
      }
    } else {
      userLoginModals.delete(modal);
    }

    const now = Date.now();
    const lastAt = lastDismissedAt.get(modal) || 0;
    if (now - lastAt < 1000) return false;
    lastDismissedAt.set(modal, now);

    const closeButton = findCloseButton(modal);
    debug('关闭登录弹层', { selector: modal.className || modal.id || modal.tagName, hasCloseButton: Boolean(closeButton) });

    try {
      if (closeButton) closeButton.click();
    } catch (error) {
      warn('点击弹层关闭按钮失败', error);
    }

    // B 站组件通常带关闭动画；短暂等待后仍存在时再隐藏，避免遮挡页面。
    setTimeout(() => {
      if (!modal.isConnected) {
        restorePageScroll();
        return;
      }
      if (!force && (userLoginModals.has(modal) || Date.now() < userLoginIntentUntil)) {
        debug('检测到用户登录意图，取消隐藏登录弹层');
        return;
      }
      hideModalFallback(modal);
      restorePageScroll();
    }, DISMISS_RETRY_MS);

    return true;
  }

  function modalClassName(modal) {
    if (typeof modal.className === 'string') return modal.className;
    return modal.getAttribute('class') || '';
  }

  function describeModal(modal) {
    const closeButton = findCloseButton(modal);
    return {
      tag: modal.tagName.toLowerCase(),
      id: modal.id || '',
      className: modalClassName(modal),
      matchedSelectors: MODAL_SELECTORS.filter((selector) => elementMatchesSelector(modal, selector)),
      closeButton: closeButton ? {
        tag: closeButton.tagName.toLowerCase(),
        className: modalClassName(closeButton),
        ariaLabel: closeButton.getAttribute('aria-label') || '',
      } : null,
      text: (modal.innerText || modal.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
    };
  }

  function scanDocument(manual = false) {
    if (!settings.dismissLoginModal && !manual) return false;
    const modals = collectVisibleModals(document);
    if (!modals.length) return false;

    let closed = false;
    for (const modal of modals) {
      if (dismissModal(modal, manual)) closed = true;
    }

    return closed;
  }

  function flushPendingRoots() {
    scanTimer = 0;
    if (!settings.dismissLoginModal) {
      pendingRoots.clear();
      return;
    }

    const roots = [...pendingRoots];
    pendingRoots.clear();
    const modals = collectVisibleModals(...roots);
    for (const modal of modals) dismissModal(modal);
  }

  function queueScan(node) {
    if (!settings.dismissLoginModal || !node) return;
    pendingRoots.add(node);
    if (scanTimer) return;
    scanTimer = setTimeout(flushPendingRoots, 80);
  }

  function startObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) queueScan(node);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function start() {
    if (started) return;
    if (!document.documentElement) {
      setTimeout(start, 20);
      return;
    }

    started = true;
    injectStyle();
    applyUiState();
    startObserver();
    scanDocument();
    document.addEventListener('click', markUserLoginIntent, true);
    refreshMenus();
    debug('脚本已启动', settings);
  }

  start();
})();
