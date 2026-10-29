// Hope Kitchen UI. Every rule that matters lives in Swift (Store.swift); this file only asks and shows.
// Built for catalogues of thousands: lists are searched and paged by the database, never loaded whole.
'use strict';

const UNITS = ['units', 'pcs', 'lbs', 'oz', 'kg', 'g', 'gallons', 'quarts', 'liters', 'cases', 'boxes', 'bags', 'dozens', 'cans', 'jars', 'trays', 'rolls', 'packs'];
const OUT_REASONS = ['Kitchen use', 'Meal service', 'To a site', 'Event', 'Donation out', 'Staff meal'];
const LOSS_REASONS = { spoiled: 'Spoiled', expired: 'Expired', damaged: 'Damaged', broken: 'Broken', other: 'Other' };
const KIND = { receive: 'In', issue: 'Out', return: 'Return', loss: 'Loss', adjust: 'Adjust', count: 'Count', undo: 'Undo', transfer: 'Move' };
const LOC_KINDS = { kitchen: 'Kitchen', storage: 'Storage', site: 'Site', vehicle: 'Vehicle' };
const REPORTS = [['pulls', 'Pull records'], ['losses', 'Loss report'], ['receiving', 'Receiving'], ['usage', 'Usage by item'], ['people', 'Activity by person'],
  ['valuation', 'Stock valuation'], ['reorder', 'Reorder list'], ['variance', 'Count variance'], ['corrections', 'Corrections & undos'], ['stockcard', 'Item stock card']];
const IDLE_MS = 10 * 60 * 1000;
const PAGE = 50;

const ICON = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  clip: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1zM8 6H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-2M9 12h6M9 16h4"/>',
  alert: '<path d="M12 3 2 20h20zM12 10v4M12 17.5v.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a5.5 5.5 0 0 1 3.5 6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  cam: '<path d="M3 8a1 1 0 0 1 1-1h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><circle cx="12" cy="13" r="4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  print: '<path d="M7 9V3h10v6M7 18H4v-8h16v8h-3M7 14h10v7H7z"/>',
  out: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/>',
  hat: '<path d="M6 14a4 4 0 1 1 1.5-7.7A5 5 0 0 1 16.5 6.3 4 4 0 1 1 18 14v6H6z"/><path d="M6 17h12"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  check: '<path d="M9 11l3 3 8-8M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11"/>',
  dl: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
};
const icon = (n, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[n] || ''}</svg>`;

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = n => { const v = Number(n || 0); return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 }); };
const money = n => (Number(n) < 0 ? '−$' : '$') + Math.abs(Number(n || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const initials = name => String(name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const when = iso => {
  if (!iso) return '';
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const stamp = iso => {
  if (!iso) return '';
  const d = new Date(iso), thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString([], { year: thisYear ? undefined : 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const stockState = it => {
  const on = Number(it.on_hand), min = Number(it.min_level);
  if (!it.active) return ['', 'Inactive'];
  if (on <= 0) return ['out', 'Out'];
  if (min > 0 && on <= min) return ['low', 'Low'];
  return ['ok', 'OK'];
};
const kindPill = k => `<span class="pill ${k === 'issue' ? 'out' : k === 'receive' ? 'in' : k}">${KIND[k] || k}</span>`;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const store = { get(k, d) { try { const v = localStorage.getItem('hk.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hk.' + k, JSON.stringify(v)); } catch { /* storage off: the default is fine */ } } };

const HK = {
  s: {
    status: null, session: null, view: 'dashboard', loc: store.get('loc', 'main'),
    scan: { mode: 'issue', qty: 1, reason: OUT_REASONS[0], to: null, last: null, feed: [], camera: false, countItem: null },
    it: { q: '', category: '', state: 'active', sort: 'category', dir: 'asc', offset: 0, here: false, sel: new Set() },
    labels: [], labelSize: 'large', ledger: { offset: 0 }, reqTab: 'open', rep: { kind: 'pulls', range: '30d' },
    signInPerson: null, pin: '', drawer: null, cache: {},
  },

  // ---- bridge ----
  api(method, args = {}) {
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.hk;
    if (!h) return Promise.reject(new Error('Open this page inside the Hope Kitchen app.'));
    return h.postMessage({ method, args }).catch(e => {
      const msg = (e && e.message) || String(e);
      if (/^Sign in first|^Signed out after/.test(msg)) { HK.s.session = null; HK.render(); }
      throw new Error(msg);
    });
  },
  native(event, data) {
    if (event === 'scan') HK.onScan(data.code, 'camera');
    if (event === 'scannerStopped') { HK.s.scan.camera = false; if (HK.s.view === 'scan') HK.render(); }
  },
  toast(msg, kind = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3200);
  },
  async run(fn) { try { return await fn(); } catch (e) { HK.toast(e.message, 'err'); } },
  can(perm) {
    const r = HK.s.session && HK.s.session.role;
    const map = {
      itemsEdit: ['director', 'inventory'], receive: ['director', 'inventory'], adjust: ['director', 'inventory'],
      issue: ['director', 'inventory', 'chef', 'staff'], requestCreate: ['director', 'inventory', 'chef', 'staff'],
      requestFulfil: ['director', 'inventory'], lossDecide: ['director'], people: ['director'],
      data: ['director', 'inventory'], labels: ['director', 'inventory'], reports: ['director', 'inventory'],
    };
    return !!r && (map[perm] || []).includes(r);
  },
  locName(id) { return (HK.s.status.locations.find(l => l.id === id) || {}).name || '—'; },
  remember(items) { (items || []).forEach(it => { if (it && it.id) HK.s.cache[it.id] = it; }); return items; },

  // ---- boot / session ----
  async boot() {
    await HK.run(async () => { HK.s.status = await HK.api('status'); HK.s.session = HK.s.status.session || null; });
    HK.fixLoc();
    HK.render();
    HK.watchIdle();
    HK.watchWedge();
    document.addEventListener('click', e => { if (!e.target.closest('.picker')) $$('.pick-list.open').forEach(l => l.classList.remove('open')); });
  },
  async refreshStatus() { HK.s.status = await HK.api('status'); HK.fixLoc(); },
  fixLoc() {
    const locs = (HK.s.status && HK.s.status.locations) || [];
    if (locs.length && !locs.some(l => l.id === HK.s.loc)) HK.s.loc = HK.s.status.defaultLocation || locs[0].id;
  },
  setLoc(id) { HK.s.loc = id; store.set('loc', id); HK.s.scan.last = null; HK.toast(`Working at ${HK.locName(id)}.`); HK.render(); },
  async signOut(reason) {
    await HK.api('signOut').catch(() => {});
    HK.s.session = null; HK.s.pin = ''; HK.s.signInPerson = null; HK.s.view = 'dashboard'; HK.s.drawer = null;
    if (HK.s.scan.camera) HK.api('scanner.stop').catch(() => {});
    if (reason) HK.toast(reason);
    HK.render();
  },
  watchIdle() {
    let last = Date.now();
    ['mousemove', 'keydown', 'mousedown'].forEach(e => addEventListener(e, () => { last = Date.now(); }, { passive: true }));
    setInterval(() => { if (HK.s.session && Date.now() - last > IDLE_MS) HK.signOut('Signed out after 10 minutes without activity.'); }, 15000);
  },
  // USB and Bluetooth scanners type fast and end with Enter. Catch them when no field has focus.
  watchWedge() {
    let buf = '', lastAt = 0;
    addEventListener('keydown', e => {
      const t = e.target;
      if (!HK.s.session && HK.s.signInPerson) {
        if (/^[0-9]$/.test(e.key)) return HK.pinKey(e.key);
        if (e.key === 'Backspace') return HK.pinKey('del');
        if (e.key === 'Enter') return HK.pinKey('go');
      }
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const now = Date.now();
      if (now - lastAt > 60) buf = '';
      lastAt = now;
      if (e.key === 'Enter') { if (buf.length >= 3) { HK.onScan(buf, 'scanner'); e.preventDefault(); } buf = ''; return; }
      if (e.key.length === 1) buf += e.key;
    });
  },
  go(view, extra) { HK.s.view = view; HK.s.drawer = null; Object.assign(HK.s, extra || {}); HK.render(); },

  // ---- item picker: type to search thousands, or scan into it ----
  pickers: {},
  picker(id, { placeholder = 'Search name, SKU or scan a label', onPick, value } = {}) {
    HK.pickers[id] = { onPick, items: [], hl: 0 };
    const chosen = value && HK.s.cache[value];
    return `<div class="picker" id="${id}-wrap"><input type="hidden" id="${id}" value="${esc(value || '')}">
      ${chosen ? `<div class="pick-chosen"><b style="flex:1">${esc(chosen.name)}</b><span class="mono faint">${esc(chosen.sku)}</span><button type="button" class="btn ghost sm" onclick="HK.pickClear('${id}')">Change</button></div>`
        : `<input id="${id}-q" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false" oninput="HK.pickSearch('${id}')" onkeydown="HK.pickKey(event,'${id}')" onfocus="HK.pickSearch('${id}')">`}
      <div class="pick-list" id="${id}-list"></div></div>`;
  },
  pickTimer: null,
  pickSearch(id) {
    clearTimeout(HK.pickTimer);
    HK.pickTimer = setTimeout(async () => {
      const q = ($('#' + id + '-q') || {}).value || '';
      const r = await HK.api('items.search', { q, limit: 12, locationId: HK.s.loc, sort: q ? 'name' : 'last_moved', dir: q ? 'asc' : 'desc' }).catch(() => null);
      if (!r) return;
      const p = HK.pickers[id]; p.items = HK.remember(r.rows); p.hl = 0;
      const list = $('#' + id + '-list'); if (!list) return;
      list.innerHTML = p.items.length ? p.items.map((it, i) => `<div class="pick-row ${i === 0 ? 'hl' : ''}" onmousedown="event.preventDefault();HK.pickChoose('${id}','${it.id}')">
          <div><b>${esc(it.name)}</b> <span class="mono faint">${esc(it.sku)}</span></div><span class="muted num">${fmt(it.here)} here · ${fmt(it.on_hand)} ${esc(it.unit)}</span></div>`).join('')
        + (r.total > 12 ? `<div class="pick-row faint">${r.total - 12} more — keep typing</div>` : '')
        : `<div class="pick-row faint">Nothing matches.</div>`;
      list.classList.add('open');
    }, 120);
  },
  async pickKey(e, id) {
    const p = HK.pickers[id];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); p.hl = Math.max(0, Math.min(p.items.length - 1, p.hl + (e.key === 'ArrowDown' ? 1 : -1)));
      $$('#' + id + '-list .pick-row').forEach((r, i) => r.classList.toggle('hl', i === p.hl));
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = e.target.value.trim();
      const exact = q && await HK.api('lookup', { code: q }).catch(() => null);   // a scanner typed a code
      if (exact && exact.found) { HK.remember([exact.item]); return HK.pickChoose(id, exact.item.id); }
      if (p.items[p.hl]) HK.pickChoose(id, p.items[p.hl].id);
    }
    if (e.key === 'Escape') $('#' + id + '-list').classList.remove('open');
  },
  pickChoose(id, itemId) {
    const it = HK.s.cache[itemId], wrap = $('#' + id + '-wrap');
    const p = HK.pickers[id];
    if (wrap) wrap.outerHTML = HK.picker(id, { onPick: p && p.onPick, value: itemId });
    if (p && p.onPick) p.onPick(it);
  },
  pickClear(id) { const p = HK.pickers[id], wrap = $('#' + id + '-wrap'); if (wrap) wrap.outerHTML = HK.picker(id, { onPick: p && p.onPick }); setTimeout(() => $('#' + id + '-q')?.focus(), 10); },

  // ---- scanning ----
  async onScan(code, source) {
    if (!HK.s.session) return;
    code = String(code).trim();
    if (!code) return;
    const d = HK.s.drawer;
    if (d && d.type === 'itemForm') { const bc = $('#f-barcode'); if (bc) { bc.value = code; HK.toast('Barcode filled from scan.'); } return; }
    if (d && d.type === 'item' && $('#code-new') && document.activeElement !== $('#code-new')) { $('#code-new').value = code; HK.toast('Barcode filled from scan. Set the pack size and Add.'); return; }
    const r = await HK.run(() => HK.api('lookup', { code }));
    if (!r) return;
    if (r.found) HK.remember([r.item]);
    if (HK.s.view === 'requests' && HK.s.fulfilling) return HK.scanIntoRequest(r);
    if (HK.s.view === 'counts' && HK.s.countOpen) return HK.scanIntoCount(r);
    if (HK.s.view !== 'scan') {
      if (r.found) return HK.openItem(r.item.id);
      return HK.toast(r.retired ? `${code} was retired. Scan another code.` : `No item uses the code ${code}.`, 'err');
    }
    if (!r.found) { HK.s.scan.last = { unknown: code, retired: r.retired }; return HK.render(); }
    const sc = HK.s.scan, pack = Number(r.packQty) || 1, qty = (Number(sc.qty) || 1) * pack;
    if (sc.mode === 'count') { sc.countItem = r.item; sc.last = { item: r.item, counting: true }; HK.render(); $('#count-input')?.focus(); return; }
    let res;
    if (sc.mode === 'transfer') {
      if (!sc.to || sc.to === HK.s.loc) return HK.toast('Pick where the stock is going first.', 'err');
      res = await HK.run(() => HK.api('transfer', { itemId: r.item.id, qty, from: HK.s.loc, to: sc.to }));
    } else {
      res = await HK.run(() => HK.api('move', { itemId: r.item.id, kind: sc.mode, qty, locationId: HK.s.loc, reason: sc.mode === 'issue' ? sc.reason : null }));
    }
    if (!res) { sc.last = { item: r.item, blocked: true }; HK.render(); return; }
    sc.last = { item: res.item, kind: sc.mode, qty, pack, packLabel: r.packLabel, flag: res.flag, movementId: res.movementId, to: sc.to };
    sc.feed.unshift({ id: res.movementId, item: res.item, kind: sc.mode, qty, at: new Date().toISOString(), flag: res.flag });
    sc.feed = sc.feed.slice(0, 60);
    sc.qty = 1;
    HK.render();
  },
  async undoMove(id) {
    const r = await HK.run(() => HK.api('undo', { id }));
    if (!r) return;
    const f = HK.s.scan.feed.find(x => x.id === id); if (f) f.undone = true;
    HK.toast(`Undone. ${r.item.name}: ${fmt(r.item.on_hand)} ${r.item.unit} in total.`, 'ok');
    HK.render();
  },
  async toggleCamera() {
    if (HK.s.scan.camera) { await HK.api('scanner.stop').catch(() => {}); HK.s.scan.camera = false; return HK.render(); }
    const r = await HK.run(() => HK.api('scanner.start'));
    if (r) { HK.s.scan.camera = !!r.running; HK.render(); }
  },

  // ---- render ----
  render() {
    const app = $('#app');
    if (!HK.s.status) { app.innerHTML = `<div class="gate"><div class="gate-card card"><h2>Starting…</h2></div></div>`; return; }
    if (HK.s.status.setupNeeded) { app.innerHTML = HK.vSetup(); return; }
    if (!HK.s.session) { app.innerHTML = HK.vSignIn(); return; }
    const v = HK.s.view;
    const views = {
      dashboard: HK.vDashboard, scan: HK.vScan, items: HK.vItems, labels: HK.vLabels, counts: HK.vCounts, requests: HK.vRequests,
      losses: HK.vLosses, reports: HK.vReports, ledger: HK.vLedger, people: HK.vPeople, settings: HK.vSettings,
    };
    const scrollTop = $('#main') ? $('#main').scrollTop : 0;
    const sameView = HK.lastView === v; HK.lastView = v;
    app.innerHTML = `<div class="shell">${HK.vSide()}<main class="main" id="main">${HK.mainCache && sameView ? HK.mainCache : '<div class="topbar"><h1>&nbsp;</h1></div>'}</main></div><div id="drawer-host">${HK.vDrawer()}</div>`;
    if (sameView) $('#main').scrollTop = scrollTop;
    Promise.resolve((views[v] || HK.vDashboard)()).then(html => {
      if (HK.s.view !== v || !$('#main')) return;
      HK.mainCache = html;
      $('#main').innerHTML = html;
      if (sameView) $('#main').scrollTop = scrollTop;
      HK.after(v);
    }).catch(e => { $('#main').innerHTML = `<div class="card">${esc(e.message)}</div>`; });
  },
  renderDrawer() { const h = $('#drawer-host'); if (h) h.innerHTML = HK.vDrawer(); },
  after(v) {
    if (v === 'scan') { if (HK.s.scan.countItem) $('#count-input')?.focus(); else $('#scan-input')?.focus(); }
    if (v === 'labels') HK.fillLabelCodes();
  },

  vSide() {
    const s = HK.s.session, v = HK.s.view;
    const nav = [
      ['dashboard', 'home', 'Overview'], ['scan', 'scan', 'Scan station'], ['items', 'box', 'Items & stock'],
      ['counts', 'check', 'Counts'], ['requests', 'clip', 'Requests'], ['losses', 'alert', 'Losses'],
      HK.can('reports') && ['reports', 'chart', 'Reports'], ['ledger', 'list', 'Ledger'], HK.can('labels') && ['labels', 'tag', 'Labels'],
      HK.can('people') && ['people', 'users', 'People'], HK.can('itemsEdit') && ['settings', 'gear', 'Settings & data'],
    ].filter(Boolean);
    const labelCount = HK.s.labels.reduce((a, l) => a + l.copies, 0);
    return `<aside class="side">
      <div class="brand"><div class="brand-mark">${icon('hat')}</div><div><b>Hope Kitchen</b><small>Hope the Mission</small></div></div>
      <div class="loc-switch"><label>Working at</label><select onchange="HK.setLoc(this.value)">${HK.s.status.locations.map(l => `<option value="${l.id}" ${l.id === HK.s.loc ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      <nav class="nav">${nav.map(([id, ic, label]) => `<button class="${v === id ? 'on' : ''}" onclick="HK.go('${id}')">${icon(ic)}<span>${label}</span>${id === 'labels' && labelCount ? `<span class="badge">${labelCount}</span>` : ''}</button>`).join('')}</nav>
      <div class="side-foot"><div class="who"><div class="avatar">${esc(initials(s.name))}</div><div style="min-width:0"><b>${esc(s.name)}</b><small>${esc(s.roleName)}</small></div>
      <button class="btn ghost sm" style="margin-left:auto" title="Sign out" onclick="HK.signOut()">${icon('out')}</button></div></div>
    </aside>`;
  },

  // ---- setup & sign in ----
  vSetup() {
    return `<div class="gate"><div class="gate-card card" style="max-width:460px">
      <div class="brand" style="padding:0 0 14px"><div class="brand-mark">${icon('hat')}</div><div><b>Hope Kitchen</b><small>First-time setup</small></div></div>
      <h1>Create the first Director</h1>
      <p class="muted">This person adds everyone else and approves losses. Choose a PIN of 4 to 8 digits; nobody else should know it.</p>
      <form class="stack" onsubmit="event.preventDefault(); HK.doSetup()">
        <label class="field">Full name<input id="s-name" required autofocus></label>
        <label class="field">PIN<input id="s-pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" required></label>
        <label class="field">PIN again<input id="s-pin2" type="password" inputmode="numeric" required></label>
        <button class="btn primary lg">Create and sign in</button>
      </form></div></div>`;
  },
  async doSetup() {
    const pin = $('#s-pin').value;
    if (pin !== $('#s-pin2').value) return HK.toast('The two PINs are different.', 'err');
    const st = await HK.run(() => HK.api('setup', { name: $('#s-name').value, pin }));
    if (st) { HK.s.status = st; HK.s.session = st.session; HK.fixLoc(); HK.go('settings'); HK.toast('Welcome. Add your storage locations, then import or add items.', 'ok'); }
  },
  vSignIn() {
    if (!HK.s.roster) { HK.api('people.roster').then(r => { HK.s.roster = r || []; HK.render(); }).catch(e => HK.toast(e.message, 'err')); return `<div class="gate"></div>`; }
    const p = HK.s.signInPerson;
    if (!p) {
      return `<div class="gate"><div class="gate-card">
        <div class="brand" style="justify-content:center"><div class="brand-mark">${icon('hat')}</div><div><b>Hope Kitchen</b><small>Tap your name to sign in</small></div></div>
        <div class="people-grid">${HK.s.roster.map(x => `<div class="person" onclick="HK.pickPerson('${x.id}')"><div class="avatar">${esc(initials(x.name))}</div><b>${esc(x.name)}</b><div class="muted" style="font-size:12px">${esc(HK.s.status.roles[x.role] || x.role)}</div></div>`).join('')}</div>
      </div></div>`;
    }
    return `<div class="gate"><div class="gate-card card" style="max-width:380px;text-align:center">
      <div class="avatar" style="margin:0 auto 10px;width:56px;height:56px;font-size:19px">${esc(initials(p.name))}</div>
      <h2>${esc(p.name)}</h2><div class="muted">Enter your PIN</div>
      <div class="dots">${Array.from({ length: Math.max(4, HK.s.pin.length) }, (_, i) => `<i class="${i < HK.s.pin.length ? 'on' : ''}"></i>`).join('')}</div>
      <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button onclick="HK.pinKey('${n}')">${n}</button>`).join('')}
        <button onclick="HK.pinKey('del')" style="font-size:15px">Delete</button><button onclick="HK.pinKey('0')">0</button>
        <button onclick="HK.pinKey('go')" style="background:var(--accent-solid);color:#1a1204;border:0;font-size:15px">Sign in</button></div>
      <button class="btn ghost" style="margin-top:14px" onclick="HK.s.signInPerson=null;HK.s.pin='';HK.render()">Not ${esc(p.name.split(' ')[0])}?</button>
    </div></div>`;
  },
  pickPerson(id) { HK.s.signInPerson = HK.s.roster.find(x => x.id === id); HK.s.pin = ''; HK.render(); },
  async pinKey(k) {
    if (k === 'del') HK.s.pin = HK.s.pin.slice(0, -1);
    else if (k === 'go') {
      const st = await HK.run(() => HK.api('signIn', { personId: HK.s.signInPerson.id, pin: HK.s.pin }));
      HK.s.pin = '';
      if (st) { HK.s.status = st; HK.s.session = st.session; HK.s.signInPerson = null; HK.s.roster = null; HK.fixLoc(); HK.s.view = HK.can('receive') ? 'dashboard' : 'scan'; }
    } else if (HK.s.pin.length < 8) HK.s.pin += k;
    HK.render();
  },

  // ---- overview ----
  async vDashboard() {
    const d = await HK.api('dashboard');
    const h = new Date().getHours();
    return `<div class="topbar"><div><h1>Good ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}, ${esc(HK.s.session.name.split(' ')[0])}</h1>
        <div class="muted">${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} · ${esc(HK.locName(HK.s.loc))}</div></div><div class="grow"></div>
        <button class="btn primary lg" onclick="HK.go('scan')">${icon('scan')} Open scan station</button></div>
      <div class="tiles">
        <div class="tile link" onclick="HK.goItems('active')"><small>Active SKUs</small><b>${fmt(d.items)}</b></div>
        <div class="tile link ${d.lowCount ? 'warn' : ''}" onclick="HK.goItems('attention')"><small>Low or out</small><b>${fmt(d.lowCount)}</b></div>
        <div class="tile"><small>Stock value</small><b>${money(d.value)}</b></div>
        <div class="tile link" onclick="HK.goReport('pulls','today')"><small>Pulled today</small><b>${money(d.pullCostToday)}</b><span class="muted">${fmt(d.pullsToday)} pulls</span></div>
        <div class="tile link ${d.pendingRequests ? 'warn' : ''}" onclick="HK.go('requests')"><small>Open requests</small><b>${d.pendingRequests}</b></div>
        <div class="tile link ${d.pendingLosses ? 'bad' : ''}" onclick="HK.go('losses')"><small>Losses to approve</small><b>${d.pendingLosses}</b></div>
        <div class="tile link" onclick="HK.go('counts')"><small>Counts open</small><b>${d.openCounts}</b></div>
        <div class="tile link" onclick="HK.go('ledger')"><small>Scans today</small><b>${fmt(d.movesToday)}</b>${d.flagged ? `<span class="pill warn">${d.flagged} flagged</span>` : ''}</div>
      </div>
      <div class="split">
        <div class="card"><div class="card-h"><h2>Needs reordering</h2><div class="row">${HK.can('reports') ? `<button class="btn sm" onclick="HK.goReport('reorder')">Reorder list by supplier</button>` : ''}</div></div>
          ${d.low.length ? `<table><tr><th>Item</th><th class="r">On hand</th><th class="r">Min</th><th class="r">Par</th><th></th></tr>
          ${d.low.map(it => { HK.remember([it]); const [c, l] = stockState(it); return `<tr class="click" onclick="HK.openItem('${it.id}')"><td><b>${esc(it.name)}</b><div class="faint mono" style="font-size:12px">${esc(it.sku)}</div></td><td class="r num">${fmt(it.on_hand)} ${esc(it.unit)}</td><td class="r num">${fmt(it.min_level)}</td><td class="r num">${fmt(it.par_level) || '—'}</td><td class="r"><span class="pill ${c}">${l}</span></td></tr>`; }).join('')}</table>
          ${d.lowCount > d.low.length ? `<div class="pager"><span>${fmt(d.lowCount - d.low.length)} more</span><button class="btn ghost sm" onclick="HK.goItems('attention')">See all</button></div>` : ''}`
          : `<div class="empty">Nothing is under its minimum. Set a minimum on an item to watch it here.</div>`}
        </div>
        <div class="card"><div class="card-h"><h2>Recent activity</h2><button class="btn ghost sm" onclick="HK.go('ledger')">Full ledger</button></div>
          ${d.recent.length ? `<div class="stack" style="gap:10px">${d.recent.map(HK.activityRow).join('')}</div>` : `<div class="empty">No scans yet today.</div>`}
        </div>
      </div>`;
  },
  goItems(state) { HK.s.it.state = state; HK.s.it.offset = 0; HK.go('items'); },
  goReport(kind, range, extra) { HK.s.rep = Object.assign({}, HK.s.rep, { kind, range: range || HK.s.rep.range }, extra || {}); HK.go('reports'); },
  activityRow(m) {
    const q = Number(m.qty);
    return `<div class="row" style="gap:10px;flex-wrap:nowrap">${kindPill(m.kind)}
      <div style="flex:1;min-width:0"><b>${esc(m.item_name)}</b> <span class="${q < 0 ? 'qty-out' : 'qty-in'} num">${q > 0 ? '+' : ''}${fmt(q)} ${esc(m.unit)}</span>
      <div class="faint" style="font-size:12px">${esc(m.person_name)} · ${when(m.created_at)} · ${esc(m.location_name)}${m.ref ? ' · ' + esc(m.ref) : ''}</div></div>
      ${m.flag ? `<span class="pill warn" title="${esc(m.flag)}">flagged</span>` : ''}</div>`;
  },

  // ---- scan station ----
  vScan() {
    const sc = HK.s.scan, locs = HK.s.status.locations;
    const modes = [['receive', 'IN', 'Delivery / restock', 'receive'], ['issue', 'OUT', 'Pull for use', 'issue'], ['return', 'RETURN', 'Back to shelf', 'issue'],
      ['transfer', 'MOVE', 'To another location', 'issue'], ['count', 'COUNT', 'Shelf count', 'adjust']];
    if (!modes.some(([m, , , p]) => m === sc.mode && HK.can(p))) sc.mode = 'issue';
    if (!sc.to || sc.to === HK.s.loc) sc.to = (locs.find(l => l.id !== HK.s.loc) || {}).id || null;
    return `<div class="topbar"><div><h1>Scan station</h1><div class="muted">At <b>${esc(HK.locName(HK.s.loc))}</b>. Pick what you're doing, then scan. Every scan is saved with your name.</div></div><div class="grow"></div>
        <button class="btn ${sc.camera ? 'camera-on' : ''}" onclick="HK.toggleCamera()">${icon('cam')} ${sc.camera ? 'Camera on — stop' : 'Use camera'}</button></div>
      <div class="scan-wrap"><div>
        <div class="modes five">${modes.map(([m, label, sub, p]) => `<button class="mode ${m} ${sc.mode === m ? 'on' : ''}" ${HK.can(p) ? '' : 'disabled'} onclick="HK.s.scan.mode='${m}';HK.s.scan.countItem=null;HK.s.scan.last=null;HK.render()">${label}<small>${sub}</small></button>`).join('')}</div>
        <div class="card flat stack">
          ${sc.mode === 'count' ? '' : `<div class="row between"><div class="row"><span class="muted" style="font-weight:600">Quantity per scan</span>
            <div class="stepper"><button onclick="HK.bumpQty(-1)">−</button><input id="qty" class="num" value="${esc(sc.qty)}" inputmode="decimal" onchange="HK.s.scan.qty=this.value" onfocus="this.select()"><button onclick="HK.bumpQty(1)">+</button></div></div>
            ${sc.mode === 'issue' ? `<select style="width:auto" onchange="HK.s.scan.reason=this.value">${OUT_REASONS.map(r => `<option ${r === sc.reason ? 'selected' : ''}>${r}</option>`).join('')}</select>` : ''}
            ${sc.mode === 'transfer' ? `<div class="row"><span class="muted">to</span><select style="width:auto" onchange="HK.s.scan.to=this.value">${locs.filter(l => l.id !== HK.s.loc).map(l => `<option value="${l.id}" ${l.id === sc.to ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>` : ''}</div>`}
          ${sc.mode === 'transfer' && locs.length < 2 ? `<div class="hint">${icon('alert')}<div>Only one location exists. Add storage areas in Settings to move stock between them.</div></div>` : ''}
          <form class="scanbox" onsubmit="event.preventDefault(); const v=$('#scan-input').value; $('#scan-input').value=''; HK.onScan(v,'typed')">
            <input id="scan-input" placeholder="Scan a label — or type a SKU and press Return" autocomplete="off" spellcheck="false">
            <button class="btn primary">Enter</button></form>
          <div class="row" style="flex-wrap:nowrap"><span class="muted" style="white-space:nowrap">No label?</span>${HK.picker('scan-pick', { placeholder: 'Search by name instead', onPick: it => { HK.onScan(it.sku, 'search'); } })}</div>
          <div class="hint">${icon('scan')}<div>A USB or Bluetooth scanner works anywhere in the app. A case barcode counts its whole pack (set pack sizes on each item).</div></div>
        </div>
        <div style="margin-top:16px">${HK.vScanResult()}</div>
      </div>
      <div class="card"><div class="card-h"><h2>This session</h2><span class="muted">${sc.feed.length} scan${sc.feed.length === 1 ? '' : 's'}</span></div>
        ${sc.feed.length ? `<div class="feed">${sc.feed.map(f => `<div class="feed-row ${f.undone ? 'undone' : ''}">
            ${kindPill(f.kind)}
            <div style="min-width:0"><b>${esc(f.item.name)}</b><div class="faint" style="font-size:12px">${when(f.at)}${f.flag ? ' · flagged' : ''}</div></div>
            <span class="num ${f.kind === 'issue' ? 'qty-out' : 'qty-in'}">${f.kind === 'issue' || f.kind === 'transfer' ? '−' : '+'}${fmt(f.qty)}</span>
            ${f.undone ? '<span></span>' : `<button class="btn ghost sm" onclick="HK.undoMove('${f.id}')">Undo</button>`}</div>`).join('')}</div>`
          : `<div class="empty">Scans you make here show up in this list, with an undo for 10 minutes.</div>`}
      </div></div>`;
  },
  bumpQty(d) { const q = Math.max(1, (Number(HK.s.scan.qty) || 1) + d); HK.s.scan.qty = q; const el = $('#qty'); if (el) el.value = q; },
  vScanResult() {
    const l = HK.s.scan.last;
    if (!l) return `<div class="result"><div class="muted">Waiting for a scan…</div></div>`;
    if (l.unknown) return `<div class="result flash-warn"><h2>${l.retired ? 'Retired barcode' : 'Unknown code'}</h2><p class="mono selectable">${esc(l.unknown)}</p>
      ${HK.can('itemsEdit') && !l.retired ? `<div class="stack"><button class="btn primary" style="align-self:flex-start" onclick="HK.openItemForm(null, '${esc(l.unknown)}')">${icon('plus')} New item with this barcode</button>
        <div class="row" style="flex-wrap:nowrap"><span class="muted" style="white-space:nowrap">or add it to</span>${HK.picker('attach-pick', { placeholder: 'an existing item', onPick: it => HK.attachCode(it, l.unknown) })}</div></div>`
        : `<p class="muted">${l.retired ? 'This barcode was taken off its item. Scan the shelf label instead.' : 'Ask an Inventory Manager to add this product.'}</p>`}</div>`;
    const it = l.item;
    if (l.counting) return `<div class="result flash-warn"><div class="row between"><div><h2>${esc(it.name)}</h2><div class="mono faint">${esc(it.sku)}</div></div><div style="text-align:right"><div class="muted">System says here</div><div class="big">${fmt(it.here ?? it.on_hand)}</div><div class="muted">${esc(it.unit)}</div></div></div>
      <form class="row" style="margin-top:14px" onsubmit="event.preventDefault(); HK.saveCount()"><label class="field" style="flex:1">What is on the shelf at ${esc(HK.locName(HK.s.loc))}?<input id="count-input" inputmode="decimal" required></label><button class="btn primary" style="align-self:flex-end">Save count</button></form></div>`;
    if (l.blocked) return `<div class="result flash-out"><h2>${esc(it.name)}</h2><p>Not recorded. See the message in the corner.</p></div>`;
    const cls = l.kind === 'issue' ? 'flash-out' : l.kind === 'receive' ? 'flash-in' : 'flash-info';
    const [st, stl] = stockState(it);
    return `<div class="result ${cls}"><div class="row between" style="align-items:flex-start"><div>${kindPill(l.kind)} <b class="num">${l.kind === 'issue' || l.kind === 'transfer' ? '−' : '+'}${fmt(l.qty)} ${esc(it.unit)}</b>
        ${l.pack > 1 ? `<span class="chip">${esc(l.packLabel || 'pack')} = ${fmt(l.pack)}</span>` : ''}${l.kind === 'transfer' ? `<span class="chip">to ${esc(HK.locName(l.to))}</span>` : ''}
        <h2 style="margin-top:10px;font-size:22px">${esc(it.name)}</h2><div class="mono faint">${esc(it.sku)}${it.location ? ' · ' + esc(it.location) : ''}</div>
        ${l.flag ? `<div class="pill warn" style="margin-top:8px">${esc(l.flag)}</div>` : ''}</div>
        <div style="text-align:right"><div class="muted">Here now</div><div class="big">${fmt(it.here)}</div><div class="muted">${esc(it.unit)} · ${fmt(it.on_hand)} in all <span class="pill ${st}">${stl}</span></div></div></div>
        <div class="row" style="margin-top:12px"><button class="btn sm" onclick="HK.undoMove('${l.movementId}')">Undo this scan</button><button class="btn ghost sm" onclick="HK.openItem('${it.id}')">Item details</button></div></div>`;
  },
  async attachCode(it, code) {
    const pack = prompt(`Add ${code} to ${it.name}.\nHow many ${it.unit} does one scan of this barcode count? (1 for a single unit, 12 for a case of 12)`, '1');
    if (pack == null) return;
    const r = await HK.run(() => HK.api('codes.add', { itemId: it.id, code, packQty: Number(pack) || 1, label: Number(pack) > 1 ? `Case of ${pack}` : 'Maker barcode' }));
    if (r) { HK.toast(`${code} now scans as ${it.name}.`, 'ok'); HK.s.scan.last = null; HK.onScan(code, 'attach'); }
  },
  async saveCount() {
    const it = HK.s.scan.countItem, v = $('#count-input').value;
    const r = await HK.run(() => HK.api('count', { itemId: it.id, counted: Number(v), locationId: HK.s.loc }));
    if (!r) return;
    HK.toast(r.delta === 0 ? `${it.name}: count matches.` : `${it.name}: recorded ${r.delta > 0 ? '+' : ''}${fmt(r.delta)} ${it.unit}.`, 'ok');
    HK.s.scan.countItem = null; HK.s.scan.last = null; HK.render();
  },

  // ---- items: paged, sorted and filtered by the database ----
  async vItems() {
    const f = HK.s.it;
    const r = await HK.api('items.search', { q: f.q, category: f.category || null, state: f.state, sort: f.sort, dir: f.dir, offset: f.offset, limit: PAGE, locationId: HK.s.loc, onlyHere: f.here });
    HK.remember(r.rows);
    HK.s.itemPage = r.rows;
    const cats = HK.s.status.categories;
    const states = [['active', 'Active'], ['attention', 'Low or out'], ['out', 'Out'], ['inactive', 'Inactive'], ['all', 'All']];
    return `<div class="topbar"><div><h1>Items & stock</h1><div class="muted">${fmt(r.total)} SKUs match · live counts from every scan</div></div><div class="grow"></div>
        ${HK.can('data') ? `<button class="btn" onclick="HK.go('settings')">Import</button>` : ''}
        ${HK.can('itemsEdit') ? `<button class="btn primary" onclick="HK.openItemForm()">${icon('plus')} New item</button>` : ''}</div>
      <div class="row" style="margin-bottom:14px">
        <input id="item-q" style="max-width:320px" placeholder="Search name, SKU, barcode, supplier" value="${esc(f.q)}" oninput="HK.itemSearch(this.value)">
        <select style="width:auto" onchange="HK.s.it.category=this.value;HK.s.it.offset=0;HK.render()"><option value="">All categories</option>${cats.map(c => `<option ${c === f.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <div class="tabs">${states.map(([k, l]) => `<button class="${f.state === k ? 'on' : ''}" onclick="HK.s.it.state='${k}';HK.s.it.offset=0;HK.render()">${l}</button>`).join('')}</div>
        <label class="row" style="gap:6px;font-weight:600;color:var(--muted)"><input type="checkbox" style="width:auto" ${f.here ? 'checked' : ''} onchange="HK.s.it.here=this.checked;HK.s.it.offset=0;HK.render()"> Only stocked here</label>
      </div>
      <div class="card" style="padding:6px 8px">${HK.itemTable(r)}</div>
      ${f.sel.size ? HK.bulkBar() : ''}`;
  },
  itemSearch(v) { clearTimeout(HK.itemTimer); HK.itemTimer = setTimeout(() => { HK.s.it.q = v; HK.s.it.offset = 0; HK.render(); setTimeout(() => { const el = $('#item-q'); if (el) { el.focus(); el.setSelectionRange(v.length, v.length); } }, 60); }, 250); },
  itemSort(k) { const f = HK.s.it; f.dir = f.sort === k && f.dir === 'asc' ? 'desc' : 'asc'; f.sort = k; f.offset = 0; HK.render(); },
  itemTable(r) {
    const f = HK.s.it, rows = r.rows;
    if (!rows.length) return `<div class="empty">${r.total === 0 && !f.q && f.state === 'active' ? 'No items yet. Add one, or import your list from Settings & data.' : 'No items match.'}</div>`;
    const th = (k, l, cls = '') => `<th class="sort ${cls} ${f.sort === k ? 'on' : ''}" onclick="HK.itemSort('${k}')">${l}${f.sort === k ? (f.dir === 'asc' ? ' ↑' : ' ↓') : ''}</th>`;
    const allSel = rows.every(it => f.sel.has(it.id));
    const open = id => `onclick="HK.openItem('${id}')"`;
    return `<table><tr>${HK.can('itemsEdit') ? `<th class="cb"><input type="checkbox" ${allSel ? 'checked' : ''} onchange="HK.selectPage(this.checked)"></th>` : ''}
        ${th('name', 'Item')}${th('sku', 'SKU')}${th('category', 'Category')}<th>Spot</th>${th('here', 'Here', 'r')}${th('on_hand', 'All locations', 'r')}${th('min_level', 'Min', 'r')}${th('value', 'Value', 'r')}${th('last_moved', 'Last move', 'r')}<th></th></tr>
      ${rows.map(it => { const [c, l] = stockState(it); return `<tr class="click">
        ${HK.can('itemsEdit') ? `<td class="cb"><input type="checkbox" ${f.sel.has(it.id) ? 'checked' : ''} onchange="HK.selectItem('${it.id}',this.checked)"></td>` : ''}
        <td ${open(it.id)}><b>${esc(it.name)}</b>${it.supplier ? `<div class="faint" style="font-size:12px">${esc(it.supplier)}</div>` : ''}</td><td class="mono" ${open(it.id)}>${esc(it.sku)}</td>
        <td class="muted" ${open(it.id)}>${esc(it.category)}</td><td class="muted" ${open(it.id)}>${esc(it.location || '—')}</td>
        <td class="r num" ${open(it.id)}><b>${fmt(it.here)}</b></td><td class="r num" ${open(it.id)}>${fmt(it.on_hand)} <span class="muted">${esc(it.unit)}</span></td>
        <td class="r num muted" ${open(it.id)}>${fmt(it.min_level)}</td><td class="r num muted" ${open(it.id)}>${it.price ? money(Math.max(0, it.on_hand) * it.price) : '—'}</td>
        <td class="r muted" ${open(it.id)}>${when(it.last_moved) || '—'}</td><td class="r" ${open(it.id)}><span class="pill ${c}">${l}</span></td></tr>`; }).join('')}</table>
      <div class="pager"><span>${fmt(f.offset + 1)}–${fmt(f.offset + rows.length)} of ${fmt(r.total)}${f.sel.size ? ` · ${f.sel.size} selected` : ''}</span>
        <div class="row"><button class="btn sm" ${f.offset ? '' : 'disabled'} onclick="HK.s.it.offset=Math.max(0,HK.s.it.offset-${PAGE});HK.render()">Previous</button>
        <button class="btn sm" ${f.offset + PAGE < r.total ? '' : 'disabled'} onclick="HK.s.it.offset+=${PAGE};HK.render()">Next</button></div></div>`;
  },
  selectItem(id, on) { const s = HK.s.it.sel; on ? s.add(id) : s.delete(id); HK.render(); },
  selectPage(on) { (HK.s.itemPage || []).forEach(it => on ? HK.s.it.sel.add(it.id) : HK.s.it.sel.delete(it.id)); HK.render(); },
  bulkBar() {
    const n = HK.s.it.sel.size;
    return `<div class="bulkbar"><b>${n} selected</b>
      <select id="bulk-field" onchange="HK.bulkField(this.value)"><option value="">Change…</option><option value="category">Category</option><option value="min_level">Minimum</option>
        <option value="par_level">Par</option><option value="price">Price</option><option value="supplier">Supplier</option><option value="location">Storage spot</option><option value="unit">Unit</option>
        <option value="active:false">Deactivate</option><option value="active:true">Reactivate</option></select>
      <span id="bulk-value"></span><button class="btn sm" onclick="HK.applyBulk()">Apply</button>
      <button class="btn sm" onclick="HK.queueSelected()">${icon('tag')} Queue labels</button>
      <button class="btn sm" onclick="HK.s.it.sel.clear();HK.render()">Clear</button></div>`;
  },
  bulkField(f) {
    const box = $('#bulk-value'); if (!box) return;
    if (f === 'category') box.innerHTML = `<select id="bulk-v">${HK.s.status.categories.map(c => `<option>${esc(c)}</option>`).join('')}</select>`;
    else if (f === 'unit') box.innerHTML = `<select id="bulk-v">${UNITS.map(u => `<option>${u}</option>`).join('')}</select>`;
    else if (f && !f.startsWith('active')) box.innerHTML = `<input id="bulk-v" style="width:140px" placeholder="New value">`;
    else box.innerHTML = '';
  },
  async applyBulk() {
    const f = $('#bulk-field').value; if (!f) return HK.toast('Choose what to change.', 'err');
    const set = f.startsWith('active') ? { active: f === 'active:true' } : { [f]: $('#bulk-v').value };
    if (!confirm(`Change ${f.replace(':', ' → ')} on ${HK.s.it.sel.size} items?`)) return;
    const r = await HK.run(() => HK.api('items.bulk', { ids: [...HK.s.it.sel], set }));
    if (r) { HK.toast(`${r.changed} items changed.`, 'ok'); HK.s.it.sel.clear(); HK.render(); }
  },
  queueSelected() { const n = HK.s.it.sel.size; [...HK.s.it.sel].forEach(id => HK.queueLabel(id, 1, true)); HK.toast(`${n} labels queued.`, 'ok'); HK.s.it.sel.clear(); HK.render(); },

  async openItem(id) {
    const it = await HK.run(() => HK.api('items.get', { id }));
    if (!it) return;
    HK.remember([it]);
    const [moves, codes] = await Promise.all([HK.api('ledger', { itemId: id, limit: 15 }).catch(() => []), HK.codesFor(it.sku)]);
    HK.s.drawer = { type: 'item', it, moves, codes };
    HK.renderDrawer();
  },
  async openItemForm(id, barcode) {
    const it = id ? HK.s.cache[id] : null;
    const cats = HK.s.status.categories;
    const category = it ? it.category : (cats.includes('Dry Goods') ? 'Dry Goods' : cats[0]);
    const sku = it ? it.sku : (await HK.api('items.nextSku', { category }).catch(() => ({}))).sku;
    HK.s.drawer = { type: 'itemForm', it, sku, barcode: barcode || '', category };
    HK.renderDrawer();
    setTimeout(() => $('#f-name')?.focus(), 30);
  },
  async catChanged(cat) {
    if (HK.s.drawer.it) return;
    const r = await HK.api('items.nextSku', { category: cat }).catch(() => null);
    if (r && $('#f-sku') && !$('#f-sku').dataset.touched) $('#f-sku').value = r.sku;
  },
  async saveItem() {
    const d = HK.s.drawer, g = id => $('#' + id)?.value;
    const body = { name: g('f-name'), category: g('f-cat'), unit: g('f-unit'), min_level: g('f-min'), par_level: g('f-par'), price: g('f-price'),
      supplier: g('f-sup'), location: g('f-loc') };
    if (d.it) { body.id = d.it.id; body.active = $('#f-active').checked; } else { body.sku = g('f-sku'); body.opening = g('f-open'); body.barcode = g('f-barcode'); body.locationId = HK.s.loc; }
    const it = await HK.run(() => HK.api('items.save', body));
    if (!it) return;
    HK.remember([it]);
    if (!d.it && HK.can('labels')) HK.queueLabel(it.id, 1, true);
    HK.toast(d.it ? 'Saved.' : `${it.name} created as ${it.sku}. Label added to the print queue.`, 'ok');
    HK.s.drawer = null;
    HK.render();
    HK.openItem(it.id);
  },
  async addCode(itemId) {
    const code = $('#code-new').value.trim(), pack = Number($('#code-pack').value) || 1, label = $('#code-label').value.trim() || (pack > 1 ? `Case of ${pack}` : 'Maker barcode');
    const it = await HK.run(() => HK.api('codes.add', { itemId, code, packQty: pack, label }));
    if (it) { HK.s.drawer.it = it; HK.renderDrawer(); HK.toast(`${code} added.`, 'ok'); }
  },
  async retireCode(code, active) {
    if (!active && !confirm(`Retire ${code}? It will stop scanning as this item. The record stays.`)) return;
    const it = await HK.run(() => HK.api('codes.setActive', { code, active }));
    if (it) { HK.s.drawer.it = it; HK.renderDrawer(); }
  },
  vDrawer() {
    const d = HK.s.drawer;
    if (!d) return '';
    const close = `<button class="btn ghost sm" onclick="HK.s.drawer=null;HK.renderDrawer()">Close</button>`;
    let body = '';
    if (d.type === 'item') {
      const it = d.it, [c, l] = stockState(it);
      body = `<div class="row between"><span class="pill ${c}">${l}</span>${close}</div>
        <h1 style="margin:10px 0 2px">${esc(it.name)}</h1><div class="mono muted">${esc(it.sku)} · ${esc(it.category)}</div>
        <div class="tiles" style="margin-top:16px;grid-template-columns:repeat(3,1fr)"><div class="tile"><small>All locations</small><b>${fmt(it.on_hand)}</b><span class="muted">${esc(it.unit)}</span></div>
          <div class="tile"><small>Pulled, 30 days</small><b>${fmt(it.pulled30)}</b><span class="muted">${it.pulled30 > 0 ? `≈ ${fmt(Math.round(it.pulled30 / 30 * 10) / 10)} a day` : ''}</span></div>
          <div class="tile"><small>Value</small><b style="font-size:22px">${money(Math.max(0, it.on_hand) * it.price)}</b></div></div>
        <div class="card flat" style="padding:8px 12px;margin-bottom:14px"><table><tr><th>Location</th><th class="r">On hand</th><th class="r">Last move</th></tr>
          ${it.levels.map(lv => `<tr><td>${esc(lv.name)}${lv.id === HK.s.loc ? ' <span class="chip">you are here</span>' : ''}</td><td class="r num"><b>${fmt(lv.on_hand)}</b> ${esc(it.unit)}</td><td class="r muted">${when(lv.last_at) || '—'}</td></tr>`).join('')}</table></div>
        <div class="label-preview">${HK.labelHTML(it, d.codes)}</div>
        <div class="row" style="margin:14px 0 18px">
          ${HK.can('labels') ? `<button class="btn" onclick="HK.queueLabel('${it.id}',1)">${icon('tag')} Queue label</button>` : ''}
          ${HK.can('itemsEdit') ? `<button class="btn" onclick="HK.openItemForm('${it.id}')">Edit</button>` : ''}
          <button class="btn" onclick="HK.openLossForm('${it.id}')">Report loss</button>
          ${HK.can('reports') ? `<button class="btn" onclick="HK.goReport('stockcard','all',{itemId:'${it.id}'})">Stock card</button>` : ''}</div>
        <dl class="kv"><dt>Storage spot</dt><dd>${esc(it.location || '—')}</dd><dt>Supplier</dt><dd>${esc(it.supplier || '—')}</dd>
          <dt>Price / ${esc(it.unit)}</dt><dd>${it.price ? money(it.price) : '—'}</dd><dt>Min / Par</dt><dd>${fmt(it.min_level)} / ${fmt(it.par_level) || '—'}</dd></dl>
        <h3 style="margin:22px 0 8px">Barcodes that scan as this item</h3>
        <table><tr><th>Code</th><th>What it is</th><th class="r">Counts as</th><th></th></tr>
          <tr><td class="mono">${esc(HK.s.status.qrPrefix + it.sku)}</td><td class="muted">Our shelf label</td><td class="r num">1 ${esc(it.unit)}</td><td></td></tr>
          ${it.codeList.map(cd => `<tr style="${cd.active ? '' : 'opacity:.5'}"><td class="mono selectable">${esc(cd.code)}</td><td>${esc(cd.label || '')}${cd.active ? '' : ' (retired)'}</td><td class="r num">${fmt(cd.pack_qty)} ${esc(it.unit)}</td>
            <td class="r">${HK.can('itemsEdit') ? `<button class="btn ghost sm" onclick="HK.retireCode('${esc(cd.code)}',${cd.active ? 'false' : 'true'})">${cd.active ? 'Retire' : 'Restore'}</button>` : ''}</td></tr>`).join('')}</table>
        ${HK.can('itemsEdit') ? `<form class="row" style="margin-top:10px;flex-wrap:nowrap" onsubmit="event.preventDefault();HK.addCode('${it.id}')">
          <input id="code-new" class="mono" placeholder="Scan or type a barcode" required><input id="code-pack" style="width:80px" inputmode="decimal" value="1" title="How many ${esc(it.unit)} one scan counts">
          <input id="code-label" style="width:140px" placeholder="e.g. Case of 12"><button class="btn">Add</button></form>` : ''}
        <h3 style="margin:22px 0 10px">Recent movements</h3>
        ${d.moves.length ? `<div class="stack" style="gap:10px">${d.moves.map(HK.activityRow).join('')}</div>` : `<div class="muted">No movements yet.</div>`}`;
    }
    if (d.type === 'itemForm') {
      const it = d.it || {}, cats = HK.s.status.categories, unit = it.unit || 'units';
      body = `<div class="row between"><h1>${d.it ? 'Edit item' : 'New item'}</h1>${close}</div>
        <p class="muted">${d.it ? 'Stock is never typed here: it comes from scans and counts.' : 'A SKU and a printable QR + barcode label are made for every new item.'}</p>
        <form class="stack" onsubmit="event.preventDefault(); HK.saveItem()">
          <label class="field">Name<input id="f-name" required value="${esc(it.name || '')}" placeholder="e.g. Roma tomatoes"></label>
          <div class="grid g2"><label class="field">Category<select id="f-cat" onchange="HK.catChanged(this.value)">${cats.map(c => `<option ${c === (it.category || d.category) ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
            <label class="field">Unit<select id="f-unit">${[...new Set([unit, ...UNITS])].map(u => `<option ${u === unit ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></label></div>
          <div class="grid g2"><label class="field">SKU${d.it ? '' : ' (made for you; you may change it)'}<input id="f-sku" class="mono" value="${esc(d.sku || '')}" ${d.it ? 'disabled' : ''} oninput="this.dataset.touched=1"></label>
            ${d.it ? `<label class="field">Active<span class="row" style="height:40px"><input id="f-active" type="checkbox" style="width:auto" ${it.active ? 'checked' : ''}> In use</span></label>` : `<label class="field">Opening count here<input id="f-open" inputmode="decimal" placeholder="What's on the shelf now"></label>`}</div>
          <div class="grid g3"><label class="field">Minimum<input id="f-min" inputmode="decimal" value="${esc(it.min_level ?? '')}"></label>
            <label class="field">Par<input id="f-par" inputmode="decimal" value="${esc(it.par_level ?? '')}"></label>
            <label class="field">Price / unit ($)<input id="f-price" inputmode="decimal" value="${esc(it.price ?? '')}"></label></div>
          <div class="grid g2"><label class="field">Storage spot<input id="f-loc" value="${esc(it.location || '')}" placeholder="Shelf 3, bin B…"></label>
            <label class="field">Supplier<input id="f-sup" value="${esc(it.supplier || '')}"></label></div>
          ${d.it ? '' : `<label class="field">Maker barcode (optional — scan the package to fill)<input id="f-barcode" class="mono" value="${esc(d.barcode || '')}"></label>`}
          <div class="row end"><button type="button" class="btn ghost" onclick="HK.s.drawer=null;HK.renderDrawer()">Cancel</button><button class="btn primary">${d.it ? 'Save' : 'Create item & label'}</button></div>
        </form>`;
    }
    if (d.type === 'lossForm') {
      body = `<div class="row between"><h1>Report a loss</h1>${close}</div><p class="muted">At ${esc(HK.locName(HK.s.loc))}. A Director approves it before the stock leaves the count.</p>
        <form class="stack" onsubmit="event.preventDefault(); HK.saveLoss()">
          <label class="field">Item${HK.picker('l-item', { value: d.itemId })}</label>
          <div class="grid g2"><label class="field">Quantity lost<input id="l-qty" inputmode="decimal" required></label>
            <label class="field">Reason<select id="l-reason">${Object.entries(LOSS_REASONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label></div>
          <label class="field">What happened<textarea id="l-note"></textarea></label>
          <div class="row end"><button class="btn primary">Send for approval</button></div></form>`;
    }
    if (d.type === 'personForm') {
      const p = d.p || {}, roles = HK.s.status.roles;
      body = `<div class="row between"><h1>${d.p ? 'Edit person' : 'Add a person'}</h1>${close}</div>
        <form class="stack" onsubmit="event.preventDefault(); HK.savePerson()">
          <label class="field">Full name<input id="p-name" required value="${esc(p.name || '')}"></label>
          <label class="field">Role<select id="p-role">${Object.entries(roles).map(([k, v]) => `<option value="${k}" ${k === (p.role || 'staff') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="field">${d.p ? 'New PIN (leave empty to keep)' : 'PIN (4–8 digits)'}<input id="p-pin" type="password" inputmode="numeric" ${d.p ? '' : 'required'}></label>
          ${d.p ? `<label class="row"><input id="p-active" type="checkbox" style="width:auto" ${p.active ? 'checked' : ''}> Active (can sign in)</label>` : ''}
          <div class="hint">People are never deleted, so their names stay on every record they made. Turn off Active instead.</div>
          <div class="row end"><button class="btn primary">Save</button></div></form>`;
    }
    if (d.type === 'locForm') {
      const l = d.l || {};
      body = `<div class="row between"><h1>${d.l ? 'Edit location' : 'Add a location'}</h1>${close}</div>
        <p class="muted">A place stock is kept: a walk-in, a dry store, a site, a van. Each has its own on-hand count.</p>
        <form class="stack" onsubmit="event.preventDefault(); HK.saveLoc()">
          <label class="field">Name<input id="lc-name" required value="${esc(l.name || '')}" placeholder="Walk-in cooler"></label>
          <label class="field">Type<select id="lc-kind">${Object.entries(LOC_KINDS).map(([k, v]) => `<option value="${k}" ${k === (l.kind || 'storage') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          ${d.l ? `<label class="row"><input id="lc-active" type="checkbox" style="width:auto" ${l.active ? 'checked' : ''}> Open (can hold stock)</label>` : ''}
          <div class="row end"><button class="btn primary">Save</button></div></form>`;
    }
    if (d.type === 'catForm') {
      const c = d.c || {};
      body = `<div class="row between"><h1>${d.c ? 'Edit category' : 'Add a category'}</h1>${close}</div>
        <p class="muted">The prefix starts every new SKU in this category (e.g. PRO-0042). Changing it only affects new items.</p>
        <form class="stack" onsubmit="event.preventDefault(); HK.saveCat()">
          <label class="field">Name<input id="ct-name" required value="${esc(c.name || '')}" ${d.c ? 'disabled' : ''}></label>
          <label class="field">SKU prefix (2–5 letters)<input id="ct-prefix" class="mono" required value="${esc(c.prefix || '')}" maxlength="5" style="text-transform:uppercase"></label>
          ${d.c ? `<label class="row"><input id="ct-active" type="checkbox" style="width:auto" ${c.active ? 'checked' : ''}> In use</label>` : ''}
          <div class="row end"><button class="btn primary">Save</button></div></form>`;
    }
    return `<div class="veil" onclick="if(event.target===this){HK.s.drawer=null;HK.renderDrawer()}"><div class="drawer">${body}</div></div>`;
  },

  // ---- labels ----
  labelHTML(it, codes = {}) {
    return `<div class="label"><img class="qr" data-sku="${esc(it.sku)}" src="${codes.qr || ''}" alt="">
      <div class="lname">${esc(it.name)}</div><div class="lsku">${esc(it.sku)}</div><div class="lmeta">${esc(it.unit)}${it.location ? ' · ' + esc(it.location) : ''}</div>
      <img class="bar" data-bar="${esc(it.sku)}" src="${codes.code128 || ''}" alt=""><div class="org"><span>Hope the Mission · Kitchen</span><span>${esc(it.category)}</span></div></div>`;
  },
  queueLabel(id, copies = 1, quiet) {
    const q = HK.s.labels.find(l => l.id === id);
    if (q) q.copies += copies; else HK.s.labels.push({ id, copies });
    if (!quiet) { HK.toast('Added to the label queue.'); HK.render(); }
  },
  vLabels() {
    const rows = HK.s.labels.map(l => ({ ...l, it: HK.s.cache[l.id] })).filter(l => l.it);
    const sheet = rows.flatMap(l => Array.from({ length: l.copies }, () => l.it));
    return `<div class="topbar"><div><h1>Labels</h1><div class="muted">QR for camera scanning, Code 128 for barcode guns. Both carry the SKU.</div></div><div class="grow"></div>
        <div class="tabs"><button class="${HK.s.labelSize === 'large' ? 'on' : ''}" onclick="HK.s.labelSize='large';HK.render()">2 per row</button><button class="${HK.s.labelSize === 'small' ? 'on' : ''}" onclick="HK.s.labelSize='small';HK.render()">3 per row</button></div>
        <button class="btn primary" ${sheet.length ? '' : 'disabled'} onclick="HK.printLabels()">${icon('print')} Print ${sheet.length} label${sheet.length === 1 ? '' : 's'}</button></div>
      <div class="split"><div class="card"><div class="card-h"><h2>Sheet preview</h2>${sheet.length > 60 ? `<span class="muted">Showing 60 of ${sheet.length}; all print.</span>` : ''}</div>
        ${sheet.length ? `<div class="label-sheet ${HK.s.labelSize}" id="sheet">${sheet.slice(0, 60).map(it => HK.labelHTML(it)).join('')}</div>` : `<div class="empty">The queue is empty. Select items on Items & stock and choose “Queue labels”, or add one below.</div>`}</div>
      <div class="card"><div class="card-h"><h2>Queue</h2>${rows.length ? `<button class="btn ghost sm" onclick="HK.s.labels=[];HK.render()">Clear</button>` : ''}</div>
        <div class="stack">${rows.slice(0, 200).map(l => `<div class="row" style="flex-wrap:nowrap"><div style="flex:1;min-width:0"><b>${esc(l.it.name)}</b><div class="mono faint" style="font-size:12px">${esc(l.it.sku)}</div></div>
          <div class="stepper"><button onclick="HK.labelCopies('${l.id}',-1)">−</button><input class="num" style="width:50px;font-size:16px" value="${l.copies}" readonly><button onclick="HK.labelCopies('${l.id}',1)">+</button></div></div>`).join('')}
          ${HK.picker('lq-item', { placeholder: 'Add an item to the queue', onPick: it => HK.queueLabel(it.id, 1) })}
          <button class="btn" onclick="HK.queueAttention()">Queue everything low or out</button></div></div></div>`;
  },
  labelCopies(id, d) { const l = HK.s.labels.find(x => x.id === id); if (!l) return; l.copies = Math.max(0, l.copies + d); HK.s.labels = HK.s.labels.filter(x => x.copies > 0); HK.render(); },
  async queueAttention() {
    const r = await HK.run(() => HK.api('items.search', { state: 'attention', limit: 500 }));
    if (!r) return;
    HK.remember(r.rows).forEach(i => HK.queueLabel(i.id, 1, true));
    HK.toast(`${r.rows.length} labels queued.`, 'ok'); HK.render();
  },
  codeCache: {},
  async codesFor(sku) { if (!HK.codeCache[sku]) HK.codeCache[sku] = await HK.api('codes', { text: HK.s.status.qrPrefix + sku }).catch(() => ({})); return HK.codeCache[sku]; },
  async fillLabelCodes(root = document) {
    for (const img of root.querySelectorAll('img[data-sku]')) {
      const c = await HK.codesFor(img.dataset.sku);
      img.src = c.qr || '';
      const bar = img.parentElement.querySelector('img[data-bar]');
      if (bar) bar.src = c.code128 || '';
    }
  },
  async printLabels() {
    const all = HK.s.labels.flatMap(l => Array.from({ length: l.copies }, () => HK.s.cache[l.id])).filter(Boolean);
    const host = $('#print-area');
    host.innerHTML = `<div class="label-sheet ${HK.s.labelSize}">${all.map(it => HK.labelHTML(it)).join('')}</div>`;
    await HK.fillLabelCodes(host);
    await HK.run(() => HK.api('print'));
  },

  // ---- cycle counts ----
  async vCounts() {
    if (HK.s.countOpen) return HK.vCountSheet();
    const list = await HK.api('counts.list');
    return `<div class="topbar"><div><h1>Counts</h1><div class="muted">Count one location (or one category) at a time. Differences post as permanent count movements.</div></div></div>
      <div class="split"><div class="card" style="padding:6px 8px">${list.length ? `<table><tr><th>Count</th><th>Location</th><th>Scope</th><th>Progress</th><th>Started</th><th></th></tr>
        ${list.map(c => `<tr class="click" onclick="HK.openCount('${c.id}')"><td class="mono"><b>${esc(c.number)}</b></td><td>${esc(c.location_name)}</td><td class="muted">${esc(c.category || 'Everything')}</td>
          <td style="min-width:140px">${c.status === 'open' ? `<div class="progress"><i style="width:${c.lines ? Math.round(c.counted / c.lines * 100) : 0}%"></i></div><span class="faint" style="font-size:12px">${fmt(c.counted)} of ${fmt(c.lines)}</span>` : c.status === 'submitted' ? `${fmt(c.changed)} changed` : '—'}</td>
          <td class="muted">${esc(c.started_by_name)} · ${when(c.started_at)}</td><td class="r"><span class="pill ${c.status === 'open' ? 'pending' : c.status === 'submitted' ? 'ok' : ''}">${c.status === 'submitted' ? 'posted' : c.status}</span></td></tr>`).join('')}</table>` : `<div class="empty">No counts yet.</div>`}</div>
      ${HK.can('adjust') ? `<div class="card" style="align-self:start"><h2 style="margin-bottom:12px">Start a count</h2><div class="stack">
        <label class="field">Location<select id="cn-loc">${HK.s.status.locations.map(l => `<option value="${l.id}" ${l.id === HK.s.loc ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
        <label class="field">Category<select id="cn-cat"><option value="">Everything</option>${HK.s.status.categories.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
        <label class="row"><input id="cn-stocked" type="checkbox" style="width:auto"> Only items with stock recorded there</label>
        <div class="hint">Counters see blank sheets by default (a blind count), so the system's number can't nudge them.</div>
        <button class="btn primary" onclick="HK.startCount()">Start count</button></div></div>` : ''}</div>`;
  },
  async startCount() {
    const r = await HK.run(() => HK.api('counts.start', { locationId: $('#cn-loc').value, category: $('#cn-cat').value || null, onlyStocked: $('#cn-stocked').checked }));
    if (r) { HK.toast(`${r.number}: ${fmt(r.lines)} items to count.`, 'ok'); HK.openCount(r.id); }
  },
  openCount(id) { HK.s.countOpen = id; HK.s.countFilter = 'all'; HK.s.countQ = ''; HK.s.countShow = 300; if (HK.s.blind == null) HK.s.blind = true; HK.render(); },
  async vCountSheet() {
    const c = await HK.api('counts.get', { id: HK.s.countOpen });
    HK.s.countData = c;
    const open = c.status === 'open', blind = HK.s.blind && open, f = HK.s.countFilter, q = (HK.s.countQ || '').toLowerCase();
    const done = c.lines.filter(l => l.counted != null).length;
    let lines = c.lines;
    if (f === 'todo') lines = lines.filter(l => l.counted == null);
    if (f === 'off') lines = lines.filter(l => l.counted != null && Number(l.counted) !== Number(l.now_on_hand));
    if (q) lines = lines.filter(l => `${l.name} ${l.sku} ${l.spot || ''}`.toLowerCase().includes(q));
    const shown = lines.slice(0, HK.s.countShow || 300);
    return `<div class="topbar"><div><h1>${esc(c.number)} · ${esc(c.location_name)}</h1><div class="muted">${esc(c.category || 'Every item')} · started by ${esc(c.started_by_name)} ${when(c.started_at)} · <span class="pill ${open ? 'pending' : 'ok'}">${open ? 'open' : c.status === 'submitted' ? 'posted' : c.status}</span></div></div><div class="grow"></div>
        <button class="btn ghost" onclick="HK.s.countOpen=null;HK.render()">All counts</button>
        ${open && HK.can('adjust') ? `<button class="btn" onclick="HK.cancelCount()">Cancel count</button><button class="btn primary" onclick="HK.submitCount()">Post count</button>` : ''}</div>
      <div class="card" style="margin-bottom:14px"><div class="row between"><div style="flex:1;max-width:420px"><div class="progress"><i style="width:${c.lines.length ? Math.round(done / c.lines.length * 100) : 0}%"></i></div>
          <span class="muted">${fmt(done)} of ${fmt(c.lines.length)} counted${open ? ' · scan a label to add 1 · type a number to set it' : ''}</span></div>
        <div class="row"><input style="width:220px" placeholder="Find on this sheet" value="${esc(HK.s.countQ || '')}" oninput="clearTimeout(HK.cqT);HK.cqT=setTimeout(()=>{HK.s.countQ=this.value;HK.render()},300)">
          <div class="tabs"><button class="${f === 'all' ? 'on' : ''}" onclick="HK.s.countFilter='all';HK.render()">All</button><button class="${f === 'todo' ? 'on' : ''}" onclick="HK.s.countFilter='todo';HK.render()">Not counted</button>${blind ? '' : `<button class="${f === 'off' ? 'on' : ''}" onclick="HK.s.countFilter='off';HK.render()">Different</button>`}</div>
          ${open ? `<label class="row" style="gap:6px;color:var(--muted);font-weight:600"><input type="checkbox" style="width:auto" ${HK.s.blind ? 'checked' : ''} onchange="HK.s.blind=this.checked;HK.render()"> Blind</label>` : ''}</div></div></div>
      <div class="card sheet" style="padding:6px 8px"><table><tr><th>Item</th><th>Spot</th><th class="r">${blind ? '' : 'System'}</th><th class="r">Counted</th><th class="r">${open ? '' : 'Posted'}</th><th>By</th></tr>
        ${shown.map(l => { const off = l.counted != null && Number(l.counted) !== Number(l.now_on_hand); return `<tr class="${l.counted != null ? 'done' : ''} ${off && !blind ? 'off' : ''}" data-item="${l.item_id}">
          <td><b>${esc(l.name)}</b> <span class="mono faint">${esc(l.sku)}</span></td><td class="muted">${esc(l.spot || '—')}</td>
          <td class="r num muted">${blind ? '' : fmt(l.now_on_hand) + ' ' + esc(l.unit)}</td>
          <td class="r">${open ? `<div class="row end" style="flex-wrap:nowrap;gap:6px"><input inputmode="decimal" value="${l.counted ?? ''}" onchange="HK.setCountLine('${l.item_id}',this.value)" onkeydown="if(event.key==='Enter'){this.blur();const n=this.closest('tr').nextElementSibling;n&&n.querySelector('input')&&n.querySelector('input').focus()}"><button class="btn ghost sm" onclick="HK.addCountLine('${l.item_id}',1)">+1</button></div>` : `<span class="num">${l.counted == null ? '—' : fmt(l.counted)}</span>`}</td>
          <td class="r num ${Number(l.applied) < 0 ? 'qty-out' : 'qty-in'}">${open || l.applied == null ? '' : (l.applied > 0 ? '+' : '') + fmt(l.applied)}</td><td class="muted">${esc(l.counted_by_name || '')}</td></tr>`; }).join('')}</table>
        ${lines.length > shown.length ? `<div class="pager"><span>Showing ${fmt(shown.length)} of ${fmt(lines.length)}</span><button class="btn sm" onclick="HK.s.countShow=(HK.s.countShow||300)+300;HK.render()">Show more</button></div>` : ''}</div>`;
  },
  async setCountLine(itemId, v) {
    const r = await HK.run(() => HK.api('counts.set', { id: HK.s.countOpen, itemId, counted: v === '' ? null : Number(v) }));
    if (r) { const row = document.querySelector(`tr[data-item="${itemId}"]`); if (row) row.classList.toggle('done', r.counted != null); }
  },
  async addCountLine(itemId, n) {
    const r = await HK.run(() => HK.api('counts.set', { id: HK.s.countOpen, itemId, add: n }));
    if (r) { HK.toast(`${r.name}: ${fmt(r.counted)} ${r.unit}`); HK.render(); }
  },
  scanIntoCount(r) {
    if (!r.found) return HK.toast(`No item uses that code.`, 'err');
    HK.addCountLine(r.item.id, Number(r.packQty) || 1);
  },
  async submitCount() {
    const c = HK.s.countData, left = c.lines.filter(l => l.counted == null).length;
    let zero = false;
    if (left) {
      const ans = prompt(`${left} items were not counted.\nType ZERO to record them as 0 (they were not on the shelf), or SKIP to leave them unchanged.`, 'SKIP');
      if (ans == null) return;
      zero = ans.trim().toUpperCase() === 'ZERO';
    }
    if (!confirm('Post this count? Every difference becomes a permanent count movement.')) return;
    const r = await HK.run(() => HK.api('counts.submit', { id: c.id, zeroUncounted: zero }));
    if (r) { HK.toast(`${r.number} posted: ${r.changed} of ${r.posted} lines changed, ${money(r.value)} net.`, 'ok'); HK.render(); }
  },
  async cancelCount() {
    if (!confirm('Cancel this count? Nothing will be posted. The sheet stays on record.')) return;
    if (await HK.run(() => HK.api('counts.cancel', { id: HK.s.countOpen }))) { HK.s.countOpen = null; HK.render(); }
  },

  // ---- requests ----
  async vRequests() {
    const tab = HK.s.reqTab;
    const list = await HK.api('requests.list', Object.assign({ locationId: HK.s.loc }, tab === 'open' ? { status: 'pending,partial,fulfilled' } : {}));
    const me = HK.s.session;
    const draft = HK.s.reqDraft || (HK.s.reqDraft = { lines: [], note: '' });
    return `<div class="topbar"><div><h1>Requests</h1><div class="muted">The kitchen asks; inventory sends by scanning; the kitchen confirms it arrived.</div></div><div class="grow"></div>
        <div class="tabs"><button class="${tab === 'open' ? 'on' : ''}" onclick="HK.s.reqTab='open';HK.render()">Open</button><button class="${tab === 'all' ? 'on' : ''}" onclick="HK.s.reqTab='all';HK.render()">All</button></div></div>
      <div class="split"><div class="stack">${list.length ? list.map(r => HK.requestCard(r, me)).join('') : `<div class="card empty">No ${tab === 'open' ? 'open ' : ''}requests.</div>`}</div>
      ${HK.can('requestCreate') ? `<div class="card" style="align-self:start"><div class="card-h"><h2>New request</h2></div>
        <div class="stack">${draft.lines.map((l, i) => `<div class="line-item"><div><b>${esc(l.item.name)}</b><div class="faint" style="font-size:12px">${fmt(l.item.on_hand)} ${esc(l.item.unit)} on hand</div></div>
            <input inputmode="decimal" value="${esc(l.qty)}" onchange="HK.s.reqDraft.lines[${i}].qty=this.value"><button class="btn ghost sm" onclick="HK.s.reqDraft.lines.splice(${i},1);HK.render()">Remove</button></div>`).join('')}
          ${HK.picker('rq-item', { placeholder: 'Add an item: search or scan', onPick: it => { HK.s.reqDraft.lines.push({ item: it, qty: 1 }); HK.render(); } })}
          <label class="field">Note for inventory<textarea id="rq-note" onchange="HK.s.reqDraft.note=this.value">${esc(draft.note)}</textarea></label>
          <button class="btn primary" ${draft.lines.length ? '' : 'disabled'} onclick="HK.sendRequest()">Send request</button></div></div>` : ''}</div>`;
  },
  requestCard(r, me) {
    const mine = r.requested_by === me.id, open = ['pending', 'partial'].includes(r.status);
    const fulfilling = HK.s.fulfilling === r.id;
    return `<div class="card"><div class="card-h"><div><h2>${esc(r.number)} <span class="pill ${r.status}">${esc(r.status)}</span></h2>
        <div class="muted" style="font-size:12.5px">${esc(r.requested_by_name)} · ${when(r.created_at)}${r.decided_by_name ? ' · handled by ' + esc(r.decided_by_name) : ''}</div></div>
        <div class="row">${open && HK.can('requestFulfil') && !fulfilling ? `<button class="btn primary sm" onclick="HK.s.fulfilling='${r.id}';HK.render()">Fulfil from here</button><button class="btn sm" onclick="HK.decideRequest('${r.id}','deny')">Deny</button>` : ''}
          ${r.status === 'pending' && (mine || me.role === 'director') ? `<button class="btn ghost sm" onclick="HK.decideRequest('${r.id}','cancel')">Cancel</button>` : ''}
          ${['fulfilled', 'partial'].includes(r.status) && (mine || ['director', 'chef'].includes(me.role)) ? `<button class="btn good sm" onclick="HK.decideRequest('${r.id}','received')">Confirm received</button>` : ''}</div></div>
      ${r.note ? `<p style="margin:0 0 10px">${esc(r.note)}</p>` : ''}${r.decided_note ? `<p class="muted" style="margin:0 0 10px">Reply: ${esc(r.decided_note)}</p>` : ''}
      <table><tr><th>Item</th><th class="r">Asked</th><th class="r">Sent</th><th class="r">Here</th>${fulfilling ? '<th class="r">Send now</th>' : ''}</tr>
      ${r.lines.map(l => { const left = Math.max(0, l.qty_requested - l.qty_fulfilled); return `<tr><td><b>${esc(l.name)}</b> <span class="mono faint">${esc(l.sku)}</span></td><td class="r num">${fmt(l.qty_requested)} ${esc(l.unit)}</td><td class="r num">${fmt(l.qty_fulfilled)}</td><td class="r num">${fmt(l.here)}</td>
        ${fulfilling ? `<td class="r"><input class="num" style="width:90px;text-align:right" data-line="${l.id}" data-sku="${esc(l.sku)}" value="${Math.min(left, Math.max(0, l.here))}"></td>` : ''}</tr>`; }).join('')}</table>
      ${fulfilling ? `<div class="row between" style="margin-top:12px"><span class="muted">${icon('scan')} Scanning an item here adds to its line.</span><div class="row"><button class="btn ghost" onclick="HK.s.fulfilling=null;HK.render()">Cancel</button><button class="btn primary" onclick="HK.fulfil('${r.id}')">Send and record</button></div></div>` : ''}</div>`;
  },
  scanIntoRequest(r) {
    if (!r.found) return HK.toast(`No item uses the code ${r.code}.`, 'err');
    const input = document.querySelector(`input[data-sku="${CSS.escape(r.item.sku)}"]`);
    if (!input) return HK.toast(`${r.item.name} is not on this request.`, 'err');
    input.value = Number(input.value || 0) + (Number(r.packQty) || 1);
    HK.toast(`${r.item.name}: ${input.value}`);
  },
  async sendRequest() {
    const d = HK.s.reqDraft;
    const r = await HK.run(() => HK.api('requests.create', { lines: d.lines.map(l => ({ itemId: l.item.id, qty: Number(l.qty) })), note: $('#rq-note')?.value || d.note }));
    if (r) { HK.s.reqDraft = null; HK.toast(`${r.number} sent to inventory.`, 'ok'); HK.render(); }
  },
  async fulfil(id) {
    const lines = $$('input[data-line]').map(i => ({ lineId: i.dataset.line, qty: Number(i.value) })).filter(l => l.qty > 0);
    const r = await HK.run(() => HK.api('requests.fulfil', { id, lines, locationId: HK.s.loc }));
    if (r) { HK.s.fulfilling = null; HK.toast(`Recorded as ${r.status}.`, 'ok'); HK.render(); }
  },
  async decideRequest(id, action) {
    let note = null;
    if (action === 'deny') { note = prompt('Why is this request denied?'); if (!note) return; }
    if (action === 'cancel' && !confirm('Cancel this request?')) return;
    const r = await HK.run(() => HK.api('requests.decide', { id, action, note }));
    if (r) { HK.toast(`Request ${r.status}.`, 'ok'); HK.render(); }
  },

  // ---- losses ----
  async vLosses() {
    const [pending, recent] = await Promise.all([HK.api('losses.list', { status: 'pending', limit: 500 }), HK.api('losses.list', { limit: 100 })]);
    return `<div class="topbar"><div><h1>Losses</h1><div class="muted">Spoiled, expired, damaged or broken stock. Reported by anyone; approved by a Director.</div></div><div class="grow"></div>
        ${HK.can('reports') ? `<button class="btn" onclick="HK.goReport('losses')">${icon('chart')} Loss report</button>` : ''}
        <button class="btn primary" onclick="HK.openLossForm()">${icon('plus')} Report a loss</button></div>
      ${pending.length ? `<div class="card" style="margin-bottom:18px"><div class="card-h"><h2>Waiting for approval</h2><span class="badge">${pending.length}</span></div>${HK.lossTable(pending, true)}</div>` : ''}
      <div class="card"><div class="card-h"><h2>Recent</h2><span class="muted">last 100 · the full history is in Reports</span></div>${HK.lossTable(recent.filter(l => l.status !== 'pending'))}</div>`;
  },
  lossTable(list, actions) {
    if (!list.length) return `<div class="empty">Nothing here.</div>`;
    return `<table><tr><th>When</th><th>Item</th><th class="r">Qty</th><th>Reason</th><th>Where</th><th>Reported by</th><th class="r">Cost</th><th></th></tr>
      ${list.map(l => `<tr><td class="muted">${when(l.created_at)}</td><td><b>${esc(l.item_name)}</b><div class="faint" style="font-size:12px">${esc(l.note || '')}</div></td><td class="r num qty-out">${fmt(l.qty)} ${esc(l.unit)}</td>
        <td><span class="pill">${LOSS_REASONS[l.reason]}</span></td><td class="muted">${esc(l.location_name || '')}</td><td>${esc(l.reported_by_name)}</td><td class="r num">${l.price ? money(l.qty * l.price) : '—'}</td>
        <td class="r">${actions && HK.can('lossDecide') ? `<div class="row end"><button class="btn good sm" onclick="HK.decideLoss('${l.id}',true)">Approve</button><button class="btn sm" onclick="HK.decideLoss('${l.id}',false)">Deny</button></div>`
          : `<span class="pill ${l.status}">${l.status}</span>${l.decided_by_name ? `<div class="faint" style="font-size:11.5px">${esc(l.decided_by_name)}</div>` : ''}`}</td></tr>`).join('')}</table>`;
  },
  openLossForm(itemId) { HK.s.drawer = { type: 'lossForm', itemId }; HK.renderDrawer(); },
  async saveLoss() {
    const r = await HK.run(() => HK.api('losses.report', { itemId: $('#l-item').value, qty: Number($('#l-qty').value), reason: $('#l-reason').value, note: $('#l-note').value, locationId: HK.s.loc }));
    if (r) { HK.s.drawer = null; HK.toast('Loss reported. A Director will review it.', 'ok'); HK.render(); }
  },
  async decideLoss(id, approve) {
    let note = null;
    if (!approve) { note = prompt('Why is this loss denied?'); if (!note) return; }
    const r = await HK.run(() => HK.api('losses.decide', { id, approve, note }));
    if (r) { HK.toast(`Loss ${r.status}.`, 'ok'); HK.render(); }
  },

  // ---- reports ----
  range(key) {
    const now = new Date(), d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = 86400000, iso = d => d.toISOString();
    switch (key) {
      case 'today': return [iso(d0), null];
      case '7d': return [iso(new Date(d0 - 6 * day)), null];
      case '30d': return [iso(new Date(d0 - 29 * day)), null];
      case 'month': return [iso(new Date(now.getFullYear(), now.getMonth(), 1)), null];
      case 'lastmonth': return [iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), iso(new Date(now.getFullYear(), now.getMonth(), 1))];
      case 'custom': { const r = HK.s.rep; return [r.from ? iso(new Date(r.from + 'T00:00')) : null, r.to ? iso(new Date(new Date(r.to + 'T00:00').getTime() + day)) : null]; }
      default: return [null, null];
    }
  },
  repArgs() {
    const r = HK.s.rep, [from, to] = HK.range(r.range);
    const a = { kind: r.kind, from, to, locationId: r.locationId || null, category: r.category || null, personId: r.personId || null, reason: r.reason || null, status: r.status || null, itemId: r.itemId || null, groupBy: r.groupBy || null };
    if (['valuation', 'reorder'].includes(r.kind)) { a.from = a.to = null; }
    return a;
  },
  async vReports() {
    const r = HK.s.rep;
    if (!HK.s.people) HK.s.people = await HK.api('people.roster').catch(() => []);
    const timeless = ['valuation', 'reorder'].includes(r.kind);
    let result = null, err = null;
    if (r.kind !== 'stockcard' || r.itemId) { try { result = await HK.api('reports.run', HK.repArgs()); } catch (e) { err = e.message; } }
    HK.s.repResult = result;
    const ranges = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['all', 'All time'], ['custom', 'Custom']];
    const sel = (id, label, opts, val) => `<select style="width:auto" onchange="HK.s.rep.${id}=this.value||null;HK.render()"><option value="">${label}</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    const groups = r.kind === 'valuation' ? [['category', 'Category'], ['location', 'Location']]
      : [['reason', 'Reason'], ['category', 'Category'], [r.kind === 'losses' ? 'reported_by' : 'person', 'Person'], ['location', 'Location'], ['name', 'Item']];
    return `<div class="topbar"><div><h1>Reports</h1><div class="muted">Read straight from the ledger. Export any report as a spreadsheet, or print it.</div></div><div class="grow"></div>
        ${result ? `<button class="btn" onclick="HK.printReport()">${icon('print')} Print</button><button class="btn primary" onclick="HK.run(async()=>{const x=await HK.api('reports.export',HK.repArgs());HK.toast('Saved '+x.file,'ok')})">${icon('dl')} Export CSV</button>` : ''}</div>
      <div class="rep-layout"><div class="rep-nav">${REPORTS.map(([k, l]) => `<button class="${r.kind === k ? 'on' : ''}" onclick="HK.s.rep.kind='${k}';HK.s.rep.groupBy=null;HK.s.rep.reason=null;HK.s.rep.status=null;HK.render()">${l}</button>`).join('')}</div>
      <div class="stack">
        <div class="row">${timeless ? '<span class="chip">As of now</span>' : `<div class="tabs">${ranges.map(([k, l]) => `<button class="${r.range === k ? 'on' : ''}" onclick="HK.s.rep.range='${k}';HK.render()">${l}</button>`).join('')}</div>`}
          ${r.range === 'custom' && !timeless ? `<input type="date" style="width:auto" value="${esc(r.from || '')}" onchange="HK.s.rep.from=this.value;HK.render()"><span class="muted">to</span><input type="date" style="width:auto" value="${esc(r.to || '')}" onchange="HK.s.rep.to=this.value;HK.render()">` : ''}</div>
        <div class="row">${r.kind === 'stockcard' ? `<div style="min-width:320px">${HK.picker('rep-item', { value: r.itemId, placeholder: 'Pick the item', onPick: it => { HK.s.rep.itemId = it.id; HK.render(); } })}</div>` : ''}
          ${r.kind !== 'reorder' ? sel('locationId', 'All locations', HK.s.status.locations.map(l => [l.id, l.name]), r.locationId) : ''}
          ${r.kind !== 'stockcard' && r.kind !== 'people' ? sel('category', 'All categories', HK.s.status.categories.map(c => [c, c]), r.category) : ''}
          ${['pulls', 'losses', 'receiving', 'corrections', 'variance', 'usage'].includes(r.kind) ? sel('personId', 'Everyone', (HK.s.people || []).map(p => [p.id, p.name]), r.personId) : ''}
          ${r.kind === 'pulls' ? sel('reason', 'Any reason', OUT_REASONS.concat(['Request']).map(x => [x, x]), r.reason) : ''}
          ${r.kind === 'losses' ? sel('reason', 'Any reason', Object.entries(LOSS_REASONS), r.reason) + sel('status', 'Any status', [['approved', 'Approved'], ['pending', 'Pending'], ['denied', 'Denied']], r.status) : ''}
          ${['pulls', 'losses', 'valuation'].includes(r.kind) ? sel('groupBy', 'Chart by…', groups, r.groupBy) : ''}</div>
        ${err ? `<div class="card" style="color:var(--out)">${esc(err)}</div>` : ''}
        ${r.kind === 'stockcard' && !r.itemId ? `<div class="card empty">Pick an item to see every movement with a running balance.</div>` : ''}
        ${result ? HK.reportBody(result) : ''}</div></div>`;
  },
  reportBody(res) {
    const max = Math.max(1, ...res.breakdown.map(b => Math.abs(b.value)));
    const cell = (c, v) => {
      if (v == null || v === '') return '<span class="faint">—</span>';
      if (c.type === 'money') return money(v);
      if (c.type === 'qty' || c.type === 'num') return fmt(v);
      if (c.type === 'date') return stamp(v);
      if (c.type === 'code') return `<span class="mono">${esc(v)}</span>`;
      if (c.key === 'kind' || c.key === 'reversed_kind') return KIND[v] ? kindPill(v) : esc(v);
      if (c.key === 'status') return `<span class="pill ${esc(v)}">${esc(v)}</span>`;
      if (c.key === 'reason' && LOSS_REASONS[v]) return LOSS_REASONS[v];
      return esc(v);
    };
    const isMoney = l => /\$|cost|value|shrink/i.test(l);
    return `<div class="tiles">${res.totals.map(t => `<div class="tile"><small>${esc(t.label)}</small><b>${isMoney(t.label) ? money(t.value) : fmt(t.value)}</b></div>`).join('')}</div>
      ${res.breakdown.length ? `<div class="card"><div class="bars">${res.breakdown.map(b => `<div class="bar-row"><span title="${esc(b.label)}">${esc(LOSS_REASONS[b.label] || b.label)}</span><div class="track"><div class="fill ${b.value < 0 ? 'neg' : ''}" style="width:${Math.abs(b.value) / max * 100}%"></div></div><span class="r num">${money(b.value)}</span></div>`).join('')}</div></div>` : ''}
      <div class="card" style="padding:6px 8px" id="report-table"><div class="scroll-x"><table><tr>${res.columns.map(c => `<th class="${['money', 'qty', 'num'].includes(c.type) ? 'r' : ''}">${esc(c.label)}</th>`).join('')}</tr>
        ${res.rows.map(row => `<tr>${res.columns.map(c => `<td class="${['money', 'qty', 'num'].includes(c.type) ? 'r num' : ''} ${['date', 'code'].includes(c.type) ? 'nw' : ''} ${c.type === 'qty' && Number(row[c.key]) < 0 ? 'qty-out' : ''}">${cell(c, row[c.key])}</td>`).join('')}</tr>`).join('')}</table></div>
        ${res.rows.length ? '' : `<div class="empty">Nothing in this range.</div>`}
        ${res.truncated ? `<div class="pager"><span>Showing ${fmt(res.rows.length)} of ${fmt(res.count)} rows. Export CSV has all of them.</span></div>` : ''}</div>
      ${res.note ? `<div class="hint">${esc(res.note)}</div>` : ''}`;
  },
  printReport() {
    const res = HK.s.repResult; if (!res) return;
    const [from, to] = HK.range(HK.s.rep.range);
    const isMoney = l => /\$|cost|value|shrink/i.test(l);
    $('#print-area').innerHTML = `<h2>${esc(res.title)}</h2><p style="font:11px -apple-system;margin:0 0 8px">${from ? stamp(from) : 'All time'} – ${to ? stamp(to) : 'now'} · printed by ${esc(HK.s.session.name)} ${stamp(new Date().toISOString())}</p>
      <p style="font:11px -apple-system">${res.totals.map(t => `<b>${esc(t.label)}:</b> ${isMoney(t.label) ? money(t.value) : fmt(t.value)}`).join(' · ')}</p>` + $('#report-table').innerHTML;
    HK.run(() => HK.api('print'));
  },

  // ---- ledger ----
  async vLedger() {
    const f = HK.s.ledger;
    const rows = await HK.api('ledger', { itemId: f.itemId, kind: f.kind, locationId: f.locationId, personId: f.personId, limit: 200, offset: f.offset });
    const me = HK.s.session;
    if (!HK.s.people) HK.s.people = await HK.api('people.roster').catch(() => []);
    const sel = (id, label, opts, val) => `<select style="width:auto" onchange="HK.s.ledger.${id}=this.value||undefined;HK.s.ledger.offset=0;HK.render()"><option value="">${label}</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    return `<div class="topbar"><div><h1>Ledger</h1><div class="muted">Every movement, permanent. Corrections are new rows, never edits.</div></div></div>
      <div class="row" style="margin-bottom:14px"><div style="min-width:300px">${HK.picker('lg-item', { value: f.itemId, placeholder: 'All items — search to filter', onPick: it => { HK.s.ledger.itemId = it.id; HK.s.ledger.offset = 0; HK.render(); } })}</div>
        ${f.itemId ? `<button class="btn ghost sm" onclick="HK.s.ledger.itemId=undefined;HK.render()">All items</button>` : ''}
        ${sel('kind', 'All types', Object.entries(KIND), f.kind)}${sel('locationId', 'All locations', HK.s.status.locations.map(l => [l.id, l.name]), f.locationId)}
        ${sel('personId', 'Everyone', (HK.s.people || []).map(p => [p.id, p.name]), f.personId)}</div>
      <div class="card" style="padding:6px 8px">${rows.length ? `<table><tr><th>When</th><th>Type</th><th>Item</th><th class="r">Qty</th><th>Where</th><th>Who</th><th>Reason / ref</th><th></th></tr>
        ${rows.map(m => { const q = Number(m.qty), canUndo = !m.undone_by && m.kind !== 'undo' && (['director', 'inventory'].includes(me.role) || (m.person_id === me.id && Date.now() - new Date(m.created_at) < 600000));
          return `<tr><td class="muted" title="${esc(m.created_at)}">${when(m.created_at)}</td><td>${kindPill(m.kind)}</td>
          <td><b>${esc(m.item_name)}</b> <span class="mono faint">${esc(m.sku)}</span></td><td class="r num ${q < 0 ? 'qty-out' : 'qty-in'}">${q > 0 ? '+' : ''}${fmt(q)} ${esc(m.unit)}</td><td class="muted">${esc(m.location_name)}</td><td>${esc(m.person_name)}</td>
          <td class="muted">${esc([m.reason, m.ref, m.note].filter(Boolean).join(' · '))}${m.flag ? ` <span class="pill warn">${esc(m.flag)}</span>` : ''}${m.undone_by ? ' <span class="pill undo">undone</span>' : ''}</td>
          <td class="r">${canUndo ? `<button class="btn ghost sm" onclick="HK.undoMove('${m.id}')">Undo</button>` : ''}</td></tr>`; }).join('')}</table>
        <div class="pager"><span>${fmt(f.offset + 1)}–${fmt(f.offset + rows.length)}</span><div class="row"><button class="btn sm" ${f.offset ? '' : 'disabled'} onclick="HK.s.ledger.offset=Math.max(0,HK.s.ledger.offset-200);HK.render()">Newer</button>
          <button class="btn sm" ${rows.length === 200 ? '' : 'disabled'} onclick="HK.s.ledger.offset+=200;HK.render()">Older</button></div></div>` : `<div class="empty">No movements match.</div>`}</div>`;
  },

  // ---- people ----
  async vPeople() {
    const list = await HK.api('people.list');
    HK.s.peopleList = list;
    return `<div class="topbar"><div><h1>People</h1><div class="muted">Who can sign in, and what each role may do.</div></div><div class="grow"></div><button class="btn primary" onclick="HK.s.drawer={type:'personForm'};HK.renderDrawer()">${icon('plus')} Add a person</button></div>
      <div class="split"><div class="card" style="padding:6px 8px"><table><tr><th>Name</th><th>Role</th><th>Status</th><th>Since</th><th></th></tr>
        ${list.map((p, i) => `<tr><td><div class="row" style="flex-wrap:nowrap"><div class="avatar">${esc(initials(p.name))}</div><b>${esc(p.name)}</b></div></td><td>${esc(HK.s.status.roles[p.role])}</td>
          <td><span class="pill ${p.active ? 'ok' : ''}">${p.active ? 'Active' : 'Inactive'}</span></td><td class="muted">${new Date(p.created_at).toLocaleDateString()}</td>
          <td class="r"><button class="btn ghost sm" onclick="HK.s.drawer={type:'personForm',p:HK.s.peopleList[${i}]};HK.renderDrawer()">Edit</button></td></tr>`).join('')}</table></div>
      <div class="card"><h2 style="margin-bottom:10px">What each role can do</h2><table>
        <tr><th></th><th>Dir</th><th>Inv</th><th>Chef</th><th>Staff</th><th>Driver</th></tr>
        ${[['Pull, return, move stock', 1, 1, 1, 1, 0], ['Receive deliveries', 1, 1, 0, 0, 0], ['Enter counts', 1, 1, 1, 1, 0], ['Start & post counts', 1, 1, 0, 0, 0],
           ['Create items, barcodes, labels', 1, 1, 0, 0, 0], ['Request stock', 1, 1, 1, 1, 0], ['Fulfil requests', 1, 1, 0, 0, 0], ['Report losses', 1, 1, 1, 1, 1],
           ['Approve losses', 1, 0, 0, 0, 0], ['Reports & exports', 1, 1, 0, 0, 0], ['People', 1, 0, 0, 0, 0]]
          .map(([l, ...v]) => `<tr><td>${l}</td>${v.map(x => `<td>${x ? '<span class="qty-in">●</span>' : '<span class="faint">·</span>'}</td>`).join('')}</tr>`).join('')}</table></div></div>`;
  },
  async savePerson() {
    const d = HK.s.drawer, body = { name: $('#p-name').value, role: $('#p-role').value, pin: $('#p-pin').value || null };
    if (d.p) { body.id = d.p.id; body.active = $('#p-active').checked; }
    const r = await HK.run(() => HK.api('people.save', body));
    if (r) { HK.s.drawer = null; HK.s.people = null; HK.toast('Saved.', 'ok'); HK.render(); }
  },

  // ---- settings & data ----
  async vSettings() {
    const [locs, cats, about] = await Promise.all([HK.api('locations.list'), HK.api('categories.list'), HK.api('about')]);
    HK.s.locList = locs; HK.s.catList = cats;
    const imp = HK.s.importPreview;
    return `<div class="topbar"><div><h1>Settings & data</h1><div class="muted">Everything is stored on this Mac. Nothing is sent anywhere.</div></div></div>
      <div class="grid g2">
        <div class="card"><div class="card-h"><h2>Locations</h2><button class="btn sm" onclick="HK.s.drawer={type:'locForm'};HK.renderDrawer()">${icon('plus')} Add</button></div>
          <table><tr><th>Name</th><th>Type</th><th></th><th></th></tr>${locs.map((l, i) => `<tr style="${l.active ? '' : 'opacity:.5'}"><td><b>${esc(l.name)}</b>${l.id === HK.s.status.defaultLocation ? ' <span class="chip">main</span>' : ''}</td><td class="muted">${LOC_KINDS[l.kind]}</td>
            <td class="muted">${l.active ? '' : 'closed'}</td><td class="r"><button class="btn ghost sm" onclick="HK.s.drawer={type:'locForm',l:HK.s.locList[${i}]};HK.renderDrawer()">Edit</button></td></tr>`).join('')}</table></div>
        <div class="card"><div class="card-h"><h2>Categories & SKU prefixes</h2><button class="btn sm" onclick="HK.s.drawer={type:'catForm'};HK.renderDrawer()">${icon('plus')} Add</button></div>
          <div style="max-height:320px;overflow-y:auto"><table><tr><th>Category</th><th>Next SKUs look like</th><th class="r">Items</th><th></th></tr>${cats.map((c, i) => `<tr style="${c.active ? '' : 'opacity:.5'}"><td>${esc(c.name)}</td><td class="mono">${esc(c.prefix)}-0001</td><td class="r num">${fmt(c.items)}</td>
            <td class="r"><button class="btn ghost sm" onclick="HK.s.drawer={type:'catForm',c:HK.s.catList[${i}]};HK.renderDrawer()">Edit</button></td></tr>`).join('')}</table></div></div>
      </div>
      <div class="card" style="margin-top:18px"><div class="card-h"><h2>Import items from a spreadsheet</h2><button class="btn sm" onclick="HK.run(async()=>{const r=await HK.api('items.template');HK.toast('Template saved: '+r.file,'ok')})">Get a template</button></div>
        <p class="muted" style="margin-top:0">Columns: SKU, Name, Category, Unit, Stock, MinLevel, ParLevel, Price, Supplier, Location, Barcode. Only Name is required. Opening stock goes to ${esc(HK.locName(HK.s.loc))}. You see a preview before anything is saved.</p>
        <div class="row"><input type="file" accept=".csv,text/csv" style="width:auto" onchange="HK.previewImport(this.files[0])">
          <label class="row" style="gap:6px"><input type="checkbox" style="width:auto" ${HK.s.importUpdate ? 'checked' : ''} onchange="HK.s.importUpdate=this.checked"> Update items whose SKU already exists (name, prices, levels — never stock)</label></div>
        ${imp ? `<div class="card flat" style="margin-top:14px"><div class="row between"><div><b>${esc(imp.fileName)}</b>: ${fmt(imp.created)} new, ${fmt(imp.updated)} updated, ${fmt(imp.skippedCount)} skipped</div>
            <div class="row"><button class="btn ghost" onclick="HK.s.importPreview=null;HK.render()">Discard</button><button class="btn primary" onclick="HK.doImport()">Import now</button></div></div>
          ${imp.preview.length ? `<table style="margin-top:10px"><tr><th>Row</th><th>Action</th><th>SKU</th><th>Name</th><th>Category</th><th class="r">Stock</th></tr>${imp.preview.map(p => `<tr><td class="muted">${p.row}</td><td><span class="pill ${p.action === 'create' ? 'in' : 'info'}">${p.action}</span></td><td class="mono">${esc(p.sku)}</td><td>${esc(p.name)}</td><td class="muted">${esc(p.category || '')}</td><td class="r num">${p.stock != null ? fmt(p.stock) : ''}</td></tr>`).join('')}</table>` : ''}
          ${imp.skipped.length ? `<details style="margin-top:10px"><summary class="muted">Skipped rows</summary><pre class="mono" style="font-size:12px;white-space:pre-wrap">${esc(imp.skipped.join('\n'))}</pre></details>` : ''}</div>` : ''}
      </div>
      <div class="grid g3" style="margin-top:18px">
        <div class="card"><h2>Export everything</h2><p class="muted">Stock by location, every movement, barcodes, counts, requests, losses, people and the audit trail as spreadsheets, into Documents › Hope Kitchen Exports.</p><button class="btn primary" onclick="HK.run(async()=>{const r=await HK.api('export');HK.toast('Exported to '+r.folder,'ok')})">Export now</button></div>
        <div class="card"><h2>Back up</h2><p class="muted">A full copy of the database. One is also made each day the app opens. Copy the backups folder off this Mac weekly.</p><button class="btn" onclick="HK.run(async()=>{const r=await HK.api('backup');HK.toast('Backup saved: '+r.file,'ok')})">Back up now</button></div>
        <div class="card"><h2>Check stock totals</h2><p class="muted">Recomputes every stock level from the ledger and compares. It should always say 0.</p><button class="btn" onclick="HK.run(async()=>{const r=await HK.api('stock.verify');HK.toast(r.mismatches.length?r.mismatches.length+' mismatches — export and send to IT':'All stock levels match the ledger.',r.mismatches.length?'err':'ok')})">Run check</button></div>
      </div>
      <div class="card" style="margin-top:18px"><dl class="kv"><dt>Version</dt><dd>Hope Kitchen ${esc(about.version)} · database v${esc(about.schema)}</dd><dt>Database</dt><dd class="mono selectable" style="word-break:break-all">${esc(about.dataPath)}</dd>
        <dt>Scanners</dt><dd>Any USB or Bluetooth QR/barcode scanner in keyboard mode with Return after each scan; or this Mac's camera.</dd></dl></div>`;
  },
  previewImport(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = async () => {
      HK.s.importText = r.result;
      const res = await HK.run(() => HK.api('import.items', { csv: r.result, dryRun: true, update: !!HK.s.importUpdate, locationId: HK.s.loc }));
      if (res) { HK.s.importPreview = Object.assign(res, { fileName: file.name }); HK.render(); }
    };
    r.readAsText(file);
  },
  async doImport() {
    const res = await HK.run(() => HK.api('import.items', { csv: HK.s.importText, update: !!HK.s.importUpdate, locationId: HK.s.loc }));
    if (!res) return;
    HK.s.importPreview = null; HK.s.importText = null;
    HK.toast(`Imported: ${fmt(res.created)} new, ${fmt(res.updated)} updated${res.skippedCount ? `, ${fmt(res.skippedCount)} skipped` : ''}.`, 'ok');
    HK.render();
  },
  async saveLoc() {
    const d = HK.s.drawer, body = { name: $('#lc-name').value, kind: $('#lc-kind').value };
    if (d.l) { body.id = d.l.id; body.active = $('#lc-active').checked; }
    if (await HK.run(() => HK.api('locations.save', body))) { HK.s.drawer = null; await HK.refreshStatus(); HK.toast('Saved.', 'ok'); HK.render(); }
  },
  async saveCat() {
    const d = HK.s.drawer, body = { name: d.c ? d.c.name : $('#ct-name').value, prefix: $('#ct-prefix').value };
    if (d.c) body.active = $('#ct-active').checked;
    if (await HK.run(() => HK.api('categories.save', body))) { HK.s.drawer = null; await HK.refreshStatus(); HK.toast('Saved.', 'ok'); HK.render(); }
  },
};

window.HK = HK;
HK.boot();
