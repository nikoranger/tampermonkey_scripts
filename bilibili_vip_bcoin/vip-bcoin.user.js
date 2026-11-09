// ==UserScript==
// @name         B 站大会员每月 B 币券自动领取并投喂
// @namespace    https://github.com/nikoranger/tampermonkey_scripts/tree/main/bilibili_vip_bcoin
// @version      0.1.0
// @description  检测当前账号是否为大会员；若是，每月自动领取 5 张 B 币券并以「充电」方式投喂给指定用户，仅扣 B 币券/余额，不扣现金
// @author       niko
// @license      MIT
// @match        https://www.bilibili.com/*
// @match        https://account.bilibili.com/*
// @run-at       document-idle
// @noframes
// @connect      api.bilibili.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// ==/UserScript==

/*
 * 功能边界
 * --------
 * 本脚本只在「当前浏览器已登录的 B 站账号」上执行三件事：
 *   1. 通过 nav 接口读取登录状态与大会员状态；
 *   2. 通过大会员权益接口领取当月的 5 张 B 币券（type=1）；
 *   3. 通过「B 币充电」接口把 B 币券投喂给指定 UID（is_bp_remains_prior=true，仅扣 B 币券/余额）。
 *
 * 它不会：
 *   - 伪造登录、Cookie 或会员身份，也不绕过任何会员/付费/DRM 校验；
 *   - 使用微信/支付宝等真实支付渠道（充电固定 is_bp_remains_prior=true，B 币不足时只报错，不扣款）；
 *   - 在账号不是大会员、未登录或未配置目标 UID 时执行领取或投喂；
 *   - 上传或收集任何账号/页面数据，所有请求都发往 B 站自己的接口。
 *
 * 注意：上述接口均为 B 站网页端使用的非公开接口，未对外承诺稳定，可能随改版失效（例如引入 WBI 签名）。
 * 脚本按「自然月」做本地去重；若你已经在别处（手动或其他工具）领过券或充过电，请用菜单里的
 * 「标记本月已完成」避免重复投喂。
 */

(function () {
  'use strict';

  const LOG_PREFIX = '[bili-vip-bcoin]';
  const SETTINGS_KEY = 'biliVipBcoin.settings.v1';
  const STATE_KEY = 'biliVipBcoin.state.v1';
  const TOAST_ID = 'bili-vip-bcoin-toast';

  const API_NAV = 'https://api.bilibili.com/x/web-interface/nav';
  const API_RECEIVE = 'https://api.bilibili.com/x/vip/privilege/receive';
  const API_ELEC_PAY = 'https://api.bilibili.com/x/ugcpay/web/v2/trade/elec/pay/quick';

  // 投喂目标 UID：可在此直接写死，更推荐用油猴菜单里的「设置投喂目标 UID」配置（菜单优先）。
  // 0 表示未配置；未配置时脚本只提示，不会领取也不会投喂。
  const DEFAULT_TARGET_UID = 0;

  const AUTO_DELAY_MS = 1500;
  const REQUEST_TIMEOUT_MS = 15000;
  const RETRY_COOLDOWN_MS = 30 * 60 * 1000;      // 失败后 30 分钟冷却
  const IDLE_COOLDOWN_MS = 6 * 60 * 60 * 1000;   // 未登录/非大会员 6 小时后再查
  const TERMINAL_STATUSES = new Set(['success']);

  const DEFAULT_SETTINGS = Object.freeze({
    autoRun: true,
    targetUid: 0,     // 0 表示未配置
    chargeNum: 5,     // 单次充电的 bp_num；1 B币 = 1 贝壳，范围 2-9999
    debug: false,
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
    scheduleAutoRun();
  }

  /* ------------------------------------------------------------------ *
   * 调度与去重
   * ------------------------------------------------------------------ */

  function scheduleAutoRun(delay = AUTO_DELAY_MS) {
    window.clearTimeout(autoTimer);
    autoTimer = 0;
    if (!settings.autoRun || shouldSkipAutoRun()) return;
    autoTimer = window.setTimeout(() => {
      autoTimer = 0;
      runFlow({ manual: false });
    }, delay);
  }

  function shouldSkipAutoRun() {
    if (!settings.autoRun) return true;
    resetStateIfNewMonth();
    if (TERMINAL_STATUSES.has(state.status)) return true;
    const idle = state.status === 'logged-out' || state.status === 'not-vip' || state.status === 'no-target';
    const cooldown = idle ? IDLE_COOLDOWN_MS : RETRY_COOLDOWN_MS;
    if (state.lastAttemptAt && Date.now() - state.lastAttemptAt < cooldown) return true;
    return false;
  }

  async function runFlow({ manual }) {
    if (running) {
      if (manual) toast('正在检查中，请稍候。', 'info', 4000);
      return;
    }
    if (!manual && shouldSkipAutoRun()) return;

    window.clearTimeout(autoTimer);
    autoTimer = 0;
    running = true;
    resetStateIfNewMonth();

    if (manual) toast('正在检查大会员状态与本月 B 币券…', 'info', 0);
    debug('开始执行', { manual, settings, state });

    try {
      const result = await performFlow();
      applyResult(result);
      const kind = statusKind(result.status);
      toast(result.message, kind, kind === 'error' ? 8000 : 6000);
      if (result.status === 'error' || result.status === 'partial') warn(result.message);
      debug('执行结果', result, state);
    } catch (error) {
      const message = `执行失败：${describeError(error)}`;
      applyResult({ status: 'error', message });
      toast(message, 'error', 8000);
      warn(message, error);
    } finally {
      running = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 主流程：检查大会员 → 领券 → 充电投喂
   * ------------------------------------------------------------------ */

  async function performFlow() {
    if (typeof GM_xmlhttpRequest !== 'function') {
      return { status: 'error', message: '当前脚本管理器不支持 GM_xmlhttpRequest，无法调用 B 站接口。' };
    }

    // 1. 登录状态 + 大会员状态
    let nav;
    try {
      nav = readJson(await request('GET', API_NAV));
    } catch (error) {
      return { status: 'error', message: `无法读取账号信息：${describeError(error)}` };
    }

    if (nav.code === -101 || (nav.data && nav.data.isLogin === false)) {
      return { status: 'logged-out', message: '当前未登录 B 站，请先登录后重试。' };
    }
    if (nav.code !== 0 || !nav.data) {
      return { status: 'error', message: `账号信息接口异常（code=${nav.code} ${nav.message || ''}）。` };
    }

    const d = nav.data;
    const vipActive = d.vipStatus === 1 || (d.vip && d.vip.status === 1);
    const vipType = Number(d.vipType || (d.vip && d.vip.type) || 0);
    const isVip = vipActive || vipType > 0;
    debug('nav', {
      mid: d.mid,
      uname: d.uname,
      vipStatus: d.vipStatus,
      vipType,
      vipActive,
      isVip,
      couponBalance: d.wallet && d.wallet.coupon_balance,
    });

    if (!isVip) {
      return { status: 'not-vip', vip: false, message: '当前账号不是大会员，已跳过本月领取与投喂。' };
    }

    // 2. 目标用户
    const targetUid = Number(settings.targetUid || DEFAULT_TARGET_UID || 0);
    if (!Number.isInteger(targetUid) || targetUid <= 0) {
      return {
        status: 'no-target',
        vip: true,
        message: '请先在油猴菜单里「设置投喂目标 UID」，否则不会领取或投喂。',
      };
    }

    const csrf = getCsrf();
    if (!csrf) {
      return {
        status: 'error',
        vip: true,
        message: '未能读取 bili_jct（CSRF Token），请确认已登录并刷新页面后重试。',
      };
    }

    // 3. 领取当月 5 张 B 币券（已领取过的接口返回 69801，视为成功）
    let claimed = state.claimed;
    if (claimed !== 'success' && claimed !== 'already') {
      const receive = await callReceive(csrf);
      claimed = receive.claimed;
      debug('领取 B 币券结果', receive);
      if (receive.status !== 'ok') {
        return { status: 'error', vip: true, claimed, message: receive.message };
      }
    }

    // 4. 充电投喂（只认 data.status === 4；已成功则本月不再重复扣券）
    if (state.charged) {
      return {
        status: 'success',
        vip: true,
        claimed,
        charged: true,
        message: `本月已完成：B 币券${claimed === 'already' ? '此前已领取' : '已领取'}，并已投喂给 UID ${targetUid}。`,
      };
    }

    const charge = await callCharge(csrf, targetUid);
    debug('充电投喂结果', charge);
    if (!charge.ok) {
      return {
        status: 'partial',
        vip: true,
        claimed,
        charged: false,
        message: `B 币券已就绪，但投喂失败：${charge.message}`,
      };
    }

    return {
      status: 'success',
      vip: true,
      claimed,
      charged: true,
      message: `本月完成：领取 5 张 B 币券并以充电方式投喂给 UID ${targetUid}（仅扣 B 币券/余额）。`,
    };
  }

  async function callReceive(csrf) {
    let json;
    try {
      json = readJson(await request('POST', API_RECEIVE, form({ type: 1, csrf }), {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://account.bilibili.com/account/big/myPackage',
        'Origin': 'https://www.bilibili.com',
      }));
    } catch (error) {
      return { status: 'error', claimed: '', message: `领取请求失败：${describeError(error)}` };
    }

    switch (json.code) {
      case 0:
        return { status: 'ok', claimed: 'success', message: '已领取本月 5 张 B 币券。' };
      case 69801:
        return { status: 'ok', claimed: 'already', message: '本月 B 币券此前已领取。' };
      case -101:
        return { status: 'error', claimed: '', message: '登录状态已失效，请重新登录 B 站。' };
      case -111:
        return { status: 'error', claimed: '', message: 'CSRF 校验失败，请刷新页面或重新登录后重试。' };
      case 69800:
        return { status: 'error', claimed: '', message: 'B 站提示「网络繁忙」，稍后会自动重试。' };
      default:
        return { status: 'error', claimed: '', message: `领取接口返回 code=${json.code} ${json.message || ''}。` };
    }
  }

  async function callCharge(csrf, upMid) {
    // 1 B币 = 1 贝壳；is_bp_remains_prior=true 表示只用 B 币券/余额，不走真实支付。
    const params = {
      bp_num: settings.chargeNum,
      is_bp_remains_prior: 'true',
      up_mid: upMid,
      otype: 'up',
      oid: upMid,
      csrf,
    };
    let json;
    try {
      json = readJson(await request('POST', API_ELEC_PAY, form(params), {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `https://space.bilibili.com/${upMid}`,
        'Origin': 'https://www.bilibili.com',
      }));
    } catch (error) {
      return { ok: false, message: `充电请求失败：${describeError(error)}` };
    }

    if (json.code === -101) return { ok: false, message: '登录状态已失效，请重新登录。' };
    if (json.code === -111) return { ok: false, message: 'CSRF 校验失败，请刷新页面后重试。' };
    if (json.code !== 0) return { ok: false, message: `充电接口返回 code=${json.code} ${json.message || ''}。` };

    const data = json.data || {};
    if (data.status === 4) return { ok: true, orderNo: data.order_no || '', message: '充电成功。' };
    if (data.status === -2) {
      return { ok: false, message: `低于充电下限，请把「单次充电数量」调大（当前 ${settings.chargeNum}）。` };
    }
    if (data.status === -4) {
      return { ok: false, message: 'B 币券/余额不足，可能本月券已用完或数量设置过大。' };
    }
    return { ok: false, message: `充电未成功（status=${data.status} ${data.msg || json.message || ''}）。` };
  }

  /* ------------------------------------------------------------------ *
   * 网络请求（GM_xmlhttpRequest，跨域携带登录 Cookie）
   * ------------------------------------------------------------------ */

  function request(method, url, body, headers) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      try {
        GM_xmlhttpRequest({
          method,
          url,
          data: body || null,
          headers: Object.assign({
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://www.bilibili.com/',
            Origin: 'https://www.bilibili.com',
          }, headers || {}),
          timeout: REQUEST_TIMEOUT_MS,
          onload: (response) => finish(resolve, response),
          onerror: (response) => finish(
            reject,
            new Error(`网络请求失败${response && response.status ? '（HTTP ' + response.status + '）' : ''}`)
          ),
          ontimeout: () => finish(reject, new Error('请求超时')),
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function readJson(response) {
    if (response && response.status && (response.status < 200 || response.status >= 300)) {
      throw new Error(`接口返回 HTTP ${response.status}`);
    }
    let json;
    try {
      json = JSON.parse(response.responseText || response.response);
    } catch (error) {
      throw new Error('接口响应不是有效 JSON');
    }
    if (!json || typeof json !== 'object') throw new Error('接口响应格式异常');
    return json;
  }

  function form(params) {
    return Object.keys(params)
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join('&');
  }

  function getCsrf() {
    try {
      const match = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]*)/);
      return match ? decodeURIComponent(match[1]) : '';
    } catch (error) {
      return '';
    }
  }

  /* ------------------------------------------------------------------ *
   * 状态与设置存储
   * ------------------------------------------------------------------ */

  function applyResult(result) {
    resetStateIfNewMonth();
    state = {
      month: state.month,
      vip: Boolean(result.vip),
      claimed: result.claimed || state.claimed || '',
      charged: result.charged === undefined ? state.charged : Boolean(result.charged),
      status: result.status,
      message: result.message,
      lastAttemptAt: Date.now(),
    };
    gmSet(STATE_KEY, state);
  }

  function resetStateIfNewMonth() {
    const month = shanghaiMonthKey();
    if (state.month !== month) {
      state = emptyState(month);
      gmSet(STATE_KEY, state);
    }
  }

  function emptyState(month = shanghaiMonthKey()) {
    return { month, vip: false, claimed: '', charged: false, status: '', message: '', lastAttemptAt: 0 };
  }

  function loadState() {
    const stored = gmGet(STATE_KEY, {});
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return emptyState();
    return {
      month: typeof stored.month === 'string' ? stored.month : '',
      vip: Boolean(stored.vip),
      claimed: typeof stored.claimed === 'string' ? stored.claimed : '',
      charged: Boolean(stored.charged),
      status: typeof stored.status === 'string' ? stored.status : '',
      message: typeof stored.message === 'string' ? stored.message : '',
      lastAttemptAt: Number.isFinite(stored.lastAttemptAt) ? stored.lastAttemptAt : 0,
    };
  }

  function loadSettings() {
    const stored = gmGet(SETTINGS_KEY, {});
    const result = Object.assign({}, DEFAULT_SETTINGS);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      if (typeof stored.autoRun === 'boolean') result.autoRun = stored.autoRun;
      if (typeof stored.debug === 'boolean') result.debug = stored.debug;
      if (Number.isInteger(stored.targetUid) && stored.targetUid >= 0) result.targetUid = stored.targetUid;
      if (Number.isInteger(stored.chargeNum) && stored.chargeNum >= 2 && stored.chargeNum <= 9999) {
        result.chargeNum = stored.chargeNum;
      }
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

  /* ------------------------------------------------------------------ *
   * 油猴菜单
   * ------------------------------------------------------------------ */

  function refreshMenus() {
    unregisterMenus();
    registerMenu(`自动执行：${settings.autoRun ? '开' : '关'}（点击切换）`, toggleAutoRun);
    const currentUid = Number(settings.targetUid || DEFAULT_TARGET_UID || 0) || '未设置';
    registerMenu(`设置投喂目标 UID（当前：${currentUid}）`, setTargetUid);
    registerMenu(`设置单次充电数量（当前：${settings.chargeNum}）`, setChargeNum);
    registerMenu('立即检查并执行', () => runFlow({ manual: true }));
    registerMenu('查看本月状态', showStatus);
    registerMenu('标记本月已完成（避免重复投喂）', markDone);
    registerMenu(`调试日志：${settings.debug ? '开' : '关'}（点击切换）`, toggleDebug);
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
        if (typeof GM_unregisterMenuCommand === 'function') GM_unregisterMenuCommand(id);
      } catch (error) {
        warn('移除油猴菜单失败', error);
      }
    }
    menuIds = [];
  }

  function setTargetUid() {
    const current = Number(settings.targetUid || DEFAULT_TARGET_UID || 0) || '';
    let input;
    try {
      input = window.prompt('请输入投喂目标用户的 UID（mid，纯数字）：', current ? String(current) : '');
    } catch (error) {
      input = null;
    }
    if (input === null) return;
    const value = String(input).trim();
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      toast('UID 必须是正整数，设置未生效。', 'error', 5000);
      return;
    }
    settings.targetUid = Number(value);
    saveSettings();
    // 重新配置目标后重置本月状态，让脚本可以立即按新目标重新检查。
    state = emptyState();
    gmSet(STATE_KEY, state);
    refreshMenus();
    toast(`投喂目标已设为 UID ${settings.targetUid}。`, 'success', 4000);
    scheduleAutoRun(300);
  }

  function setChargeNum() {
    let input;
    try {
      input = window.prompt('请输入单次充电数量（bp_num，2-9999，默认 5）：', String(settings.chargeNum));
    } catch (error) {
      input = null;
    }
    if (input === null) return;
    const value = Number(String(input).trim());
    if (!Number.isInteger(value) || value < 2 || value > 9999) {
      toast('请输入 2~9999 之间的整数，设置未生效。', 'error', 5000);
      return;
    }
    settings.chargeNum = value;
    saveSettings();
    refreshMenus();
    toast(`单次充电数量已设为 ${value}。`, 'success', 4000);
  }

  function markDone() {
    resetStateIfNewMonth();
    state.status = 'success';
    state.message = '已手动标记本月完成，本月将不再自动领取或投喂。';
    state.lastAttemptAt = Date.now();
    gmSet(STATE_KEY, state);
    window.clearTimeout(autoTimer);
    autoTimer = 0;
    toast(state.message, 'success', 6000);
  }

  function showStatus() {
    resetStateIfNewMonth();
    if (!state.status) {
      toast(settings.autoRun ? '本月尚未检查。' : '自动执行已关闭，本月尚未检查。', 'info', 5500);
      return;
    }
    const time = formatTime(state.lastAttemptAt);
    toast(`${state.message}${time ? `（检查于 ${time}）` : ''}`, statusKind(state.status), 7000);
  }

  function toggleAutoRun() {
    settings.autoRun = !settings.autoRun;
    saveSettings();
    refreshMenus();
    window.clearTimeout(autoTimer);
    autoTimer = 0;
    if (settings.autoRun) {
      toast('自动执行已开启。', 'success', 3500);
      scheduleAutoRun(300);
    } else {
      toast('自动执行已关闭，仍可从菜单手动执行。', 'info', 4500);
    }
  }

  function toggleDebug() {
    settings.debug = !settings.debug;
    saveSettings();
    refreshMenus();
    toast(`调试日志已${settings.debug ? '开启' : '关闭'}。`, 'info', 3500);
  }

  /* ------------------------------------------------------------------ *
   * 工具函数
   * ------------------------------------------------------------------ */

  function statusKind(status) {
    if (status === 'success') return 'success';
    if (status === 'error') return 'error';
    if (status === 'logged-out' || status === 'not-vip' || status === 'no-target' || status === 'partial') {
      return 'warn';
    }
    return 'info';
  }

  function describeError(error) {
    if (!error) return '未知错误';
    if (error.name === 'AbortError') return '请求超时';
    return error.message || String(error);
  }

  function shanghaiMonthKey(date = new Date()) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
      }).formatToParts(date);
      const values = {};
      for (const part of parts) values[part.type] = part.value;
      return `${values.year}-${values.month}`;
    } catch (error) {
      return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
    }
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(timestamp));
    } catch (error) {
      return '';
    }
  }

  function debug(...args) {
    if (settings.debug) console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  /* ------------------------------------------------------------------ *
   * 页面内提示（Shadow DOM，避免被站点样式污染）
   * ------------------------------------------------------------------ */

  function toast(message, kind = 'info', duration = 6000) {
    try {
      let host = document.getElementById(TOAST_ID);
      if (host && !host.shadowRoot) {
        host.remove();
        host = null;
      }
      if (!host) {
        host = document.createElement('div');
        host.id = TOAST_ID;
        host.style.cssText = 'all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;display:block;';
        (document.body || document.documentElement).appendChild(host);

        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `
          <style>
            :host { all: initial; }
            .card {
              box-sizing: border-box;
              width: min(380px, calc(100vw - 28px));
              display: grid;
              grid-template-columns: minmax(0, 1fr) auto;
              gap: 12px;
              align-items: start;
              padding: 13px 14px;
              border-left: 4px solid #3a8f5a;
              border-radius: 12px;
              background: #202124;
              color: #f5f5f5;
              box-shadow: 0 12px 38px rgba(0, 0, 0, .3);
              font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
            }
            .card[data-kind="warn"] { border-left-color: #d99a32; }
            .card[data-kind="error"] { border-left-color: #d95d5d; }
            .body { min-width: 0; }
            .title { display: block; margin-bottom: 2px; color: #fff; font-size: 12px; font-weight: 700; }
            .message { display: block; overflow-wrap: anywhere; color: #d9d9d9; }
            .close {
              appearance: none; width: 24px; height: 24px; padding: 0; border: 0;
              border-radius: 6px; background: transparent; color: #a9a9a9; cursor: pointer;
              font: 18px/24px sans-serif;
            }
            .close:hover { background: rgba(255, 255, 255, .08); color: #fff; }
          </style>
          <section class="card" role="status" aria-live="polite" data-kind="info">
            <div class="body">
              <strong class="title">B 站大会员 B 币券</strong>
              <span class="message"></span>
            </div>
            <button class="close" type="button" aria-label="关闭通知">×</button>
          </section>`;
        root.querySelector('.close').addEventListener('click', (event) => {
          event.stopPropagation();
          host.style.display = 'none';
        });
      }

      const root = host.shadowRoot;
      root.querySelector('.card').dataset.kind = kind;
      root.querySelector('.message').textContent = message;
      window.clearTimeout(toastTimer);
      host.style.display = 'block';
      if (duration > 0) {
        toastTimer = window.setTimeout(() => {
          host.style.display = 'none';
        }, duration);
      }
    } catch (error) {
      // 提示失败不影响主流程。
    }
  }
})();
