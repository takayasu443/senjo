/* 洗浄タスク管理アプリ  v2.0.2
 * - 分娩舎（列ごと）・離乳舎（部屋ごと）・離乳舎の通路・肥育舎（部屋ごと）の洗浄／消毒を
 *   「だれが・どこを・どこまで・何分かけて」で記録する
 * - スマホ1台でも動く（記録はまず端末内に保存。畜舎の中で電波が無くても記録できる）
 * - 招待リンクで接続すると、全員のスマホが同じDropboxフォルダを介して同期される（在庫アプリと同じ方式）
 *   ・端末ごとに自分の記録ファイル records/<端末ID>.json だけを書くので、同時に使っても上書き事故が起きない
 *   ・名前の選択肢と注意ポイントは shared.json（パソコンの tools/senjo_sync.py で更新）。このファイルには名前を書かない
 * - 共通ロジックは core.js（検証・統合・進捗・CSV）。このファイルは画面と保存・同期の制御
 *
 * v2.0.1（2026-11-15）分娩舎に「母豚消毒完了」（列ごと）を追加（現場からの要望）
 * v2.0.0（2026-11-15）在庫アプリと同じ方式（公開URL＋共有同期＋招待リンク）に作り直し。v1 は1ファイル版
 */
(() => {
'use strict';

const APP_VERSION = '2.0.2';
const C = window.WSCore;
const { BARNS, WASHING, STATUS_SHORT, TSURO_ROOM, fingerprint, validateEvents, validateShared, emptyShared, cautionsOf, mergeEvents, orderEvents,
  voidedSet, unitKey, latestByUnit, recordsOfUnit, buildCsv, apiArg, b64url, unb64url, barnOf, statusOf, dateOK, unitLabel, placeLabel, statusText } = C;
const LS = { events: 'ws_events', cfg: 'ws_cfg', device: 'ws_device', shared: 'ws_shared', revs: 'ws_revs', sent: 'ws_sent', dismiss: 'ws_dismiss', quarantine: 'ws_quarantine' };
const HASH_KEY = 'senjo';                       // 招待リンクの目印（#senjo=…）。在庫アプリ（#setup=…）と取り違えないよう別の名前
const DIR = '/records', SHARED_FILE = '/shared.json';

// ---------- 保存まわり ----------
let storageOK = true;
try { localStorage.setItem('ws_test', '1'); localStorage.removeItem('ws_test'); } catch (e) { storageOK = false; }
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
/** 失敗したら例外。呼び出し側が「保存できなかった」と扱えるようにする */
const writeLS = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); };
/** 失敗を通知だけして続ける版（設定など、記録以外に使う） */
const save = (k, v) => { try { writeLS(k, v); return true; } catch (e) { toast('端末への保存に失敗しました: ' + e.message, 4000); return false; } };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SAVE_FAIL_MSG = '端末に保存できませんでした（空き容量を確認してください）。入力はそのまま残しています';

// ---------- 端末の種類（iPhone のホーム画面アプリは Safari と保存領域が別なので扱いを分ける） ----------
const DBG = load('ws_debug', null) || {};      // 検証用の上書き { ios: true, standalone: true }
const UA = navigator.userAgent;
const IS_IOS = DBG.ios != null ? !!DBG.ios : (/iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
const IS_STANDALONE = DBG.standalone != null ? !!DBG.standalone : (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true);
const IS_LINE = /\bLine\//i.test(UA);

let deviceId = load(LS.device, null);
if (!deviceId || !C.ID_RE.test(deviceId)) { deviceId = 'd' + uid(); save(LS.device, deviceId); }

const DBX_DEFAULT = { appKey: '', basePath: '', refreshToken: '', accessToken: '', expiresAt: 0 };
const state = {
  events: [], shared: emptyShared(),
  cfg: Object.assign({ lastName: '', lastNameOther: false, pollSec: 30, revoked: '' }, load(LS.cfg, {})),
  revs: load(LS.revs, {}),                      // Dropbox上のファイルrev（変更のないファイルは再取得しない）
  sent: Object.assign({ fp: '', ids: [], base: null }, load(LS.sent, {})),   // 最後に送信した自分の記録（指紋とID）
  tab: 'home', boardBarn: 'bunben', logLimit: 100,
  sync: { status: 'off', last: 0, msg: '', busy: false },
  installPrompt: null, swWaiting: null, updateRequested: false,
};
state.cfg.dropbox = Object.assign({}, DBX_DEFAULT, state.cfg.dropbox || {});
// 起動時の読み込み（壊れていても落ちないように検証つき。不正な記録だけ隔離して残りを使う）
{
  const raw = load(LS.events, []);
  try { state.events = validateEvents(raw); }
  catch (e) {
    console.warn('記録の一部を読めませんでした。不正な記録だけ隔離します', e);
    const good = [], bad = [], seen = new Set();
    for (const x of (Array.isArray(raw) ? raw : [])) {
      try { validateEvents([x]); if (seen.has(x.id)) throw new Error('ID重複'); seen.add(x.id); good.push(x); }
      catch (err) { bad.push({ at: Date.now(), why: err.message, item: x }); }
    }
    state.events = good;
    if (bad.length) { try { writeLS(LS.quarantine, load(LS.quarantine, []).concat(bad).slice(-200)); } catch (e2) { } }
  }
}
try { state.shared = validateShared(load(LS.shared, {})); } catch (e) { state.shared = emptyShared(); }

const persistMeta = () => { save(LS.cfg, state.cfg); save(LS.revs, state.revs); save(LS.sent, state.sent); try { syncAddressBar(); } catch (e) { } };

/** 別タブなどが先に保存した記録を取り込んでから書く（上書き事故の防止） */
function reloadEventsFromStorage() {
  let stored; try { stored = validateEvents(load(LS.events, [])); } catch (e) { return 0; }
  const m = mergeEvents(state.events, stored);
  if (m.added) state.events = m.events;
  return m.added;
}
window.addEventListener('storage', (e) => { if (e.key === LS.events && reloadEventsFromStorage()) refreshView(); });

// ---------- 記録から導くもの（記録が変わるまで使い回す） ----------
let derivedCache = null;
function derived() {
  const key = state.events.length + ':' + (state.events.length ? state.events[state.events.length - 1].id : '');
  if (!derivedCache || derivedCache.key !== key) derivedCache = { key, voided: voidedSet(state.events), latest: latestByUnit(state.events) };
  return derivedCache;
}
const connected = () => !!state.cfg.dropbox.refreshToken;
const basePath = () => String(state.cfg.dropbox.basePath || '').replace(/\/+$/, '');
const ownEvents = () => orderEvents(state.events.filter((e) => e.dev === deviceId));
const ownText = () => JSON.stringify(ownEvents());
const eventsPending = () => { const own = ownEvents(); return own.length > 0 && (fingerprint(JSON.stringify(own)) !== state.sent.fp || state.sent.base !== basePath()); };
function unsentIds() {
  const own = state.events.filter((e) => e.dev === deviceId);
  if (!connected() || state.sent.base !== basePath()) return new Set(own.map((e) => e.id));
  const sent = new Set(state.sent.ids || []);
  return new Set(own.filter((e) => !sent.has(e.id)).map((e) => e.id));
}
const unsentCount = () => unsentIds().size;

/** 記録を追加（複数まとめて）。端末に保存できたときだけ state に反映する。失敗時は例外 */
function addEvents(list) {
  const now = Date.now();
  const evs = list.map((ev, i) => Object.assign({ id: uid(), ts: now + i, dev: deviceId }, ev));
  validateEvents(evs);
  reloadEventsFromStorage();
  const next = state.events.concat(evs);
  validateEvents(next);
  writeLS(LS.events, next);               // ← ここで失敗したら例外。state は変えない
  state.events = next;
  scheduleSync(); updateHeader();
  return evs;
}

// ---------- 画面部品 ----------
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
let toastTimer; let viewStale = false;
function toast(msg, ms = 2400) {
  const t = document.getElementById('toast'); if (!t) return; t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function openSheet(html) { const s = $('#sheet'); $('.sheet-body', s).innerHTML = html; s.classList.remove('hidden'); return $('.sheet-body', s); }
function closeSheet() { $('#sheet').classList.add('hidden'); if (viewStale) setTimeout(() => { if (viewStale && !sheetOpen()) refreshView(); }, 0); }
const sheetOpen = () => !$('#sheet').classList.contains('hidden');
let sheetLocked = false;                       // 送信中は背景タップで閉じない
$('.sheet-bg').addEventListener('click', () => { if (!sheetLocked) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOpen() && !sheetLocked) closeSheet(); });

const pad = (n) => String(n).padStart(2, '0');
const dstr = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => dstr(new Date());
const dateJa = (s) => { if (!dateOK(s)) return ''; const d = new Date(s + 'T00:00:00'); return (d.getMonth() + 1) + '月' + d.getDate() + '日（' + '日月火水木金土'[d.getDay()] + '）'; };
const md = (s) => { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(s || ''); return m ? (+m[1]) + '/' + (+m[2]) : ''; };
const minJa = (min) => { const h = Math.floor(min / 60), m = min % 60; return (h ? h + '時間' : '') + ((m || !h) ? m + '分' : ''); };
const fmtTime = (ts) => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const namesOf = (barnKey) => (state.shared.names && state.shared.names[barnKey]) || [];
const cautionHtml = () => { const c = cautionsOf(state.shared); return c.length ? `<div class="caution">⚠️ <b>洗うときの注意ポイント</b><br>${c.map((x) => '・' + esc(x)).join('<br>')}</div>` : ''; };

// ---------- タブ：入力（ホーム） ----------
function homeHtml() {
  const n = unsentCount();
  return `
  ${storageOK ? '' : '<div class="errmsg">⚠️ このブラウザでは記録を保存できません（プライベートモードなど）。ふつうの画面で開き直してください。</div>'}
  <div class="today">📅 今日は ${dateJa(today())}</div>
  <div class="card">
    <h2><span class="num">1</span>洗った場所をえらんで記録</h2>
    <div class="barn-btns">${BARNS.map((b) => `<button class="barn-btn" data-act="start" data-barn="${b.key}"><span class="ic">${b.icon}</span><span class="nm">${b.label}</span><span class="sb">${b.sub}</span></button>`).join('')}</div>
  </div>
  <div class="card send-card ${n ? 'has' : ''}">
    <h2><span class="num">2</span>最後に送信</h2>
    <div class="unsent">まだ送っていない記録<b id="unsent-n">${n}</b>件</div>
    <button class="btn green" id="send-btn" data-act="send" ${n ? '' : 'disabled'}>📤 送信する</button>
    <div class="signal">📶 <b>休憩室など、電波の届くところ</b>で送信してください。<br>畜舎の中では記録だけしておけば大丈夫です（電波が届けば自動でも送られます）。</div>
  </div>
  ${cautionHtml()}`;
}

// ---------- 入力フォーム ----------
let D = null;          // 入力中の下書き
function startEntry(barnKey) {
  const b = barnOf(barnKey); if (!b) return;
  const names = namesOf(barnKey);
  D = { barn: barnKey, date: today(), room: '', cols: [], rooms: [], status: b.statuses.length === 1 ? b.statuses[0].key : '', pct: 0, nameIdx: -1, other: '', h: 0, m: 0, memo: '', editRef: null, err: '', errSec: '' };
  if (state.cfg.lastName) { const i = names.indexOf(state.cfg.lastName); if (i >= 0) D.nameIdx = i; else if (state.cfg.lastNameOther || !names.length) { D.nameIdx = names.length; D.other = state.cfg.lastName; } }
  state.tab = 'form'; render(); window.scrollTo(0, 0);
}
function editRecord(id) {
  const r = state.events.find((x) => x.id === id && x.type === 'rec'); if (!r || derived().voided.has(id)) return;
  const b = barnOf(r.barn); const names = namesOf(r.barn); const i = names.indexOf(r.name);
  D = { barn: r.barn, date: r.date, room: b.cols ? r.units[0].room : '', cols: b.cols ? r.units.map((u) => u.col) : [], rooms: (b.rooms && !b.cols) ? r.units.map((u) => u.room) : [],
    status: r.status, pct: r.status === 'washing' ? r.pct : 0, nameIdx: i >= 0 ? i : names.length, other: i >= 0 ? '' : r.name, h: Math.floor(r.minutes / 60), m: r.minutes % 60, memo: r.memo || '', editRef: id, err: '', errSec: '' };
  state.tab = 'form'; render(); window.scrollTo(0, 0);
}
function leaveForm() { const back = D && D.editRef ? 'log' : 'home'; D = null; state.tab = back; render(); window.scrollTo(0, 0); }
function rerenderKeep() { const y = window.scrollY; render(); window.scrollTo(0, y); }
const clearErr = () => { D.err = ''; D.errSec = ''; };
function draftUnits() {
  const b = barnOf(D.barn);
  if (!b.rooms) return [{ room: TSURO_ROOM, col: '' }];
  if (b.cols) return D.room ? b.cols.filter((c) => D.cols.includes(c)).map((c) => ({ room: D.room, col: c })) : [];
  return b.rooms.filter((r) => D.rooms.includes(r)).map((r) => ({ room: r, col: '' }));
}
function draftName() { const names = namesOf(D.barn); return D.nameIdx < 0 ? '' : D.nameIdx < names.length ? names[D.nameIdx] : String(D.other || '').trim(); }
function placeHtml(b) {
  if (!b.rooms) return `<div class="picked" style="margin-top:0;font-size:17px;">${b.label}（${b.sub}）</div>`;
  const roomBtns = (sel) => `<div class="grid g${b.perRow}">${b.rooms.map((r) => `<button class="pick ${sel(r) ? 'sel' : ''}" data-act="room" data-v="${r}">${r}${b.suffix ? `<small>${b.suffix}</small>` : ''}</button>`).join('')}</div>`;
  if (b.cols) {
    return `<div class="sublabel">部屋（1〜6番）</div>${roomBtns((r) => D.room === r)}
      <div class="sublabel">列（洗った列・いくつでも選べます）</div>
      <div class="grid g4" id="cols">${b.cols.map((c) => `<button class="pick ${D.cols.includes(c) ? 'sel' : ''}" data-act="col" data-v="${c}">${c}<small>列</small></button>`).join('')}</div>
      <button class="pick sub" data-act="allcols">${D.cols.length === b.cols.length ? '全部の列をはずす' : '全部の列（1〜4列）をえらぶ'}</button>`;
  }
  return `<p class="note" style="margin-bottom:8px;">同じ作業をまとめて行ったときは、いくつでも選べます</p>${roomBtns((r) => D.rooms.includes(r))}`;
}
function formHtml() {
  const b = barnOf(D.barn); const units = draftUnits(); const names = namesOf(D.barn); const e = (k) => (D.errSec === k ? ' err' : '');
  let num = 0; const n = () => `<span class="num">${++num}</span>`;
  const picked = units.length && b.rooms ? `選んだ場所: ${units.map((u) => unitLabel(b.key, u.room, u.col)).join('・')}${units.length > 1 ? `（${units.length}か所）` : ''}` : '';
  return `
  ${b.rooms ? cautionHtml() : ''}
  <div class="card${e('date')}" id="sec-date">
    <h2>${n()}日付<span class="opt">自動で今日の日付が入ります</span></h2>
    <input type="date" class="inp" id="f-date" data-f="date" value="${esc(D.date)}" max="${today()}">
  </div>
  <div class="card${e('place')}" id="sec-place">
    <h2>${n()}場所<span class="opt">${b.cols ? '列ごと' : b.rooms ? '部屋ごと' : ''}</span></h2>
    ${placeHtml(b)}
    ${b.rooms ? `<div class="picked">${esc(picked)}</div>` : ''}
  </div>
  <div class="card${e('status')}" id="sec-status">
    <h2>${n()}どこまで終わりましたか</h2>
    <div class="list">${b.statuses.map((s) => `<button class="pick ${D.status === s.key ? 'sel' : ''}" data-act="status" data-v="${s.key}">${s.label}${s.pcts ? '（25%・50%・75%）' : ''}</button>`).join('')}</div>
    ${D.status === 'washing' ? `<div class="pctbox"><div class="sublabel">全体のどのくらいまで洗えましたか</div>
      <div class="grid g3">${WASHING.pcts.map((p) => `<button class="pick ${D.pct === p ? 'sel' : ''}" data-act="pct" data-v="${p}">${p}%</button>`).join('')}</div></div>` : ''}
  </div>
  <div class="card${e('name')}" id="sec-name">
    <h2>${n()}名前</h2>
    <div class="wrapbtns">${names.map((nm, i) => `<button class="pick ${D.nameIdx === i ? 'sel' : ''}" data-act="name" data-v="${i}">${esc(nm)}</button>`).join('')}
      <button class="pick ${D.nameIdx === names.length ? 'sel' : ''}" data-act="name" data-v="${names.length}">その他</button></div>
    ${D.nameIdx === names.length ? `<input type="text" class="inp" id="other-name" data-f="other" style="margin-top:10px;" maxlength="20" placeholder="名前を入力" value="${esc(D.other)}">` : ''}
  </div>
  <div class="card${e('time')}" id="sec-time">
    <h2>${n()}かかった時間<span class="opt">おおよそでOK</span></h2>
    <div class="timerow">
      <select class="inp" id="f-h" data-f="h">${Array.from({ length: 13 }, (_, i) => `<option value="${i}" ${D.h === i ? 'selected' : ''}>${i}</option>`).join('')}</select><span>時間</span>
      <select class="inp" id="f-m" data-f="m">${Array.from({ length: 12 }, (_, i) => i * 5).map((v) => `<option value="${v}" ${D.m === v ? 'selected' : ''}>${v}</option>`).join('')}</select><span>分</span>
    </div>
    <div class="rest">⏱ 休憩時間は<u>除いて</u>入れてください</div>
  </div>
  <div class="card">
    <h2>${n()}メモ<span class="opt">書かなくてもOK</span></h2>
    <textarea class="inp" id="f-memo" data-f="memo" rows="2" maxlength="200" placeholder="気づいたこと・引き継ぎなど">${esc(D.memo)}</textarea>
  </div>
  ${D.err ? `<div class="errmsg" id="errmsg">⚠️ ${esc(D.err)}</div>` : ''}
  <button class="btn" id="save-btn" data-act="save">✅ ${D.editRef ? '直した内容で記録する' : '記録する'}</button>
  <button class="btn secondary" data-act="leave">やめる</button>`;
}
function validateDraft() {
  const b = barnOf(D.barn);
  if (!dateOK(D.date)) return ['date', '日付を入れてください'];
  if (D.date > today()) return ['date', '日付が今日より先になっています'];
  if (b.cols && !D.room) return ['place', '部屋をえらんでください'];
  if (b.cols && !D.cols.length) return ['place', '洗った列をえらんでください'];
  if (b.rooms && !b.cols && !D.rooms.length) return ['place', '部屋をえらんでください'];
  if (!D.status) return ['status', 'どこまで終わったかをえらんでください'];
  if (D.status === 'washing' && !WASHING.pcts.includes(D.pct)) return ['status', '洗浄途中のときは 25%・50%・75% のどれかをえらんでください'];
  if (!draftName()) return ['name', D.nameIdx < 0 ? '名前をえらんでください' : '名前を入力してください'];
  if (D.h * 60 + D.m <= 0) return ['time', 'かかった時間（休憩を除く）を入れてください'];
  return null;
}
function saveEntry() {
  const v = validateDraft();
  if (v) { D.errSec = v[0]; D.err = v[1]; render(); const el = document.getElementById('sec-' + v[0]); if (el) el.scrollIntoView({ block: 'center' }); toast(v[1]); return; }
  const name = draftName(); const names = namesOf(D.barn);
  const rec = { type: 'rec', date: D.date, barn: D.barn, units: draftUnits(), status: D.status, pct: D.status === 'washing' ? D.pct : 100, name, minutes: D.h * 60 + D.m, memo: String(D.memo || '').trim() };
  const wasEdit = !!D.editRef; const barnKey = D.barn; let saved;
  try { saved = addEvents(wasEdit ? [rec, { type: 'void', ref: D.editRef, name }] : [rec])[0]; }      // 直す＝新しい記録＋古い記録の取消
  catch (e) { console.error(e); toast(SAVE_FAIL_MSG + '（' + e.message + '）', 6000); return; }
  state.cfg.lastName = name; state.cfg.lastNameOther = !names.includes(name); persistMeta();
  D = null; state.tab = wasEdit ? 'log' : 'home'; render(); window.scrollTo(0, 0);
  openSheet(`<h2>✅ ${wasEdit ? '直しました' : '記録しました'}</h2>
    <p><b>${esc(placeLabel(saved))}</b><br>${esc(statusText(saved))}　${esc(saved.name)}　${minJa(saved.minutes)}</p>
    <button class="btn green" data-act="send">📤 いま送信する</button>
    <div class="signal">📶 休憩室など、<b>電波の届くところ</b>で送信してください</div>
    <button class="btn outline" data-act="start" data-barn="${barnKey}">✏️ 続けて記録する</button>
    <button class="btn secondary" data-act="close-sheet">あとで送信する（閉じる）</button>`);
}

// ---------- タブ：履歴（全員分） ----------
function logHtml() {
  const { voided } = derived(); const unsent = unsentIds();
  const list = state.events.filter((e) => e.type === 'rec').sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  if (!list.length) return `<div class="card"><h2>📋 記録の履歴</h2><p class="note">まだ記録がありません。「入力」から記録してください。</p></div>`;
  return `<div class="card"><h2>📋 記録の履歴<span class="opt">${connected() ? '全員分' : 'この端末の分'}</span></h2>
    <p class="note" style="margin:-6px 0 10px;">まちがえたときは「直す」か「取消」を押してください（取り消した記録も薄く残ります）。</p>
    ${list.slice(0, state.logLimit).map((r) => { const mine = r.dev === deviceId; const vd = voided.has(r.id); return `<div class="rec ${vd ? 'void' : ''}">
      <div class="top"><span>${dateJa(r.date)}</span>
        ${vd ? '<span class="tagb cx">取消済み</span>' : ''}
        ${mine ? (unsent.has(r.id) ? '<span class="tagb un">未送信</span>' : '<span class="tagb ok">送信済み</span>') : ''}
        ${mine ? '<span class="tagb mine">この端末</span>' : ''}</div>
      <div class="place">${esc(placeLabel(r))}</div>
      <div class="st">${esc(statusText(r))}</div>
      <div class="meta">👤 ${esc(r.name)}　⏱ ${minJa(r.minutes)}${r.memo ? `<br>📝 ${esc(r.memo)}` : ''}</div>
      ${vd ? '' : `<div class="acts"><button class="sbtn" data-act="edit" data-id="${esc(r.id)}">✏️ 直す</button><button class="sbtn red" data-act="void" data-id="${esc(r.id)}">🗑 取消</button></div>`}
    </div>`; }).join('')}
    ${list.length > state.logLimit ? `<button class="btn secondary" data-act="more">続きを表示（残り ${list.length - state.logLimit}件）</button>` : ''}
  </div>`;
}
function voidRecord(id) {
  const r = state.events.find((x) => x.id === id && x.type === 'rec'); if (!r || derived().voided.has(id)) return;
  if (!confirm(placeLabel(r) + '（' + statusText(r) + '・' + r.name + '）の記録を取り消しますか？')) return;
  try { addEvents([{ type: 'void', ref: id }]); } catch (e) { toast(SAVE_FAIL_MSG, 6000); return; }
  toast('取り消しました'); render();
}

// ---------- タブ：進捗（全員分） ----------
function cellHtml(barnKey, room, col, label, latest) {
  const r = latest.get(unitKey(barnKey, room, col));
  // 最後の記録日から FRESH_DAYS 日をこえた場所は色を外す（記録は消えず、押すと履歴が見られる）
  const stale = !!r && !C.isFresh(r.date, today());
  const st = r && !stale ? r.status : '';
  const txt = !r ? '記録なし' : stale ? (C.ageDays(r.date, today()) + '日前') : (st === 'washing' ? '途中 ' + r.pct + '%' : (STATUS_SHORT[st] || st));
  return `<button class="cell ${st}${stale ? ' stale' : ''}" data-act="unit" data-barn="${barnKey}" data-room="${esc(room)}" data-col="${esc(col)}"><span class="u">${esc(label)}</span><span class="s">${esc(txt)}</span><span class="d">${r ? md(r.date) + ' ' + esc(r.name) : ''}</span></button>`;
}
function boardHtml() {
  const b = barnOf(state.boardBarn); const { latest } = derived(); let grid;
  if (b.cols) {
    grid = `<div class="board" style="grid-template-columns:44px repeat(4,1fr);"><div></div>${b.cols.map((c) => `<div class="rowlabel">${c}列</div>`).join('')}
      ${b.rooms.map((r) => `<div class="rowlabel">${r}番</div>${b.cols.map((c) => cellHtml(b.key, r, c, r + '-' + c, latest)).join('')}`).join('')}</div>`;
  } else if (b.rooms) {
    grid = `<div class="board" style="grid-template-columns:repeat(${b.perRow},1fr);">${b.rooms.map((r) => cellHtml(b.key, r, '', r + (b.suffix || ''), latest)).join('')}</div>`;
  } else {
    grid = `<div class="board" style="grid-template-columns:1fr;">${cellHtml(b.key, TSURO_ROOM, '', b.label + '（' + b.sub + '）', latest)}</div>`;
  }
  const keys = [...new Set(b.statuses.map((s) => s.key))];
  return `<div class="card">
    <h2>📊 どこまで終わっているか</h2>
    <div class="grid g4" style="margin-bottom:12px;">${BARNS.map((x) => `<button class="pick wide ${state.boardBarn === x.key ? 'sel' : ''}" data-act="board" data-barn="${x.key}">${x.key === 'tsuro' ? '通路' : x.label}</button>`).join('')}</div>
    <div class="legend">${keys.map((k) => `<span class="cell ${k}">${k === 'washing' ? '洗浄途中' : esc(statusOf(b.key, k).label)}</span>`).join('')}<span class="cell">記録なし</span><span class="cell stale">${C.FRESH_DAYS}日より前</span></div>
    ${grid}
    <p class="note" style="margin-top:12px;">それぞれの場所の<b>いちばん新しい記録</b>（日付と入力した人）です。押すとその場所の記録が見られます。<br>
    最後の記録から<b>${C.FRESH_DAYS}日</b>をこえた場所は、色が外れて「○日前」と灰色で表示されます（記録は「履歴」に残っています）。<br>
    ${connected() ? '全員の記録が自動で集まります（右上の ⟳ で今すぐ更新）。' : '※まだ共有されていないので、この端末で入力した記録だけが表示されます。'}</p>
  </div>`;
}
function showUnit(barnKey, room, col) {
  const b = barnOf(barnKey); if (!b) return;
  const list = recordsOfUnit(state.events, barnKey, room, col);
  openSheet(`<h2>${esc(b.label)} ${b.rooms ? esc(unitLabel(barnKey, room, col)) : '（' + esc(b.sub) + '）'}</h2>
    ${list.length ? list.slice(0, 30).map((x) => `<div class="rec"><div class="top">${dateJa(x.date)}</div><div class="st"><b>${esc(statusText(x))}</b></div>
      <div class="meta">👤 ${esc(x.name)}　⏱ ${minJa(x.minutes)}${x.units.length > 1 ? `（${x.units.length}か所まとめて）` : ''}${x.memo ? `<br>📝 ${esc(x.memo)}` : ''}</div></div>`).join('') : '<p class="note">まだ記録がありません。</p>'}
    <button class="btn secondary" data-act="close-sheet">閉じる</button>`);
}

// ---------- タブ：設定 ----------
const redirectUri = () => (location.origin + location.pathname).replace(/index\.html$/, '');
function settingsHtml() {
  const dbx = state.cfg.dropbox; const on = connected(); const url = redirectUri(); const n = unsentCount();
  const nameLines = BARNS.map((b) => `<div>${esc(b.label)}</div><div>${namesOf(b.key).map(esc).join('・') || '<span class="muted">（未設定）</span>'}</div>`).join('');
  return `
    <div class="card">
      <h2>🔄 みんなで共有する</h2>
      <div class="kv">
        <div>状態</div><div><span class="dot ${on ? state.sync.status : 'off'}"></span> ${esc(syncLabel())}</div>
        <div>未送信</div><div>${n}件</div>
        <div>この端末ID</div><div class="mono small">${esc(deviceId)}</div>
      </div>
      <details ${on ? '' : 'open'} style="margin-top:8px"><summary>招待リンクを貼り付けて接続${on ? 'し直す' : 'する'}</summary>
        <p class="note">LINEで届いた洗浄アプリのメッセージ（またはリンク）をコピーして、ここに貼り付けてください。ホーム画面のアプリで「端末のみ（未共有）」と出るときに使います。</p>
        <div class="row" style="margin-top:6px"><input id="paste-link" class="inp grow" placeholder="ここに貼り付け" autocapitalize="off" autocomplete="off"><button class="btn sm" data-act="paste-go">接続</button></div>
      </details>
      <details style="margin-top:8px"><summary>他の人のスマホを設定する（招待リンク）</summary>
        <p class="note">この端末の接続設定を入れたリンクを作ります。LINEで送って開いてもらうと、同じ設定になります。<b>リンクを持っている人はこのアプリの記録を読み書きできる</b>ので、社内の該当者だけに送ってください。</p>
        <button class="btn sm" data-act="invite" ${on ? '' : 'disabled'} style="margin-top:6px">招待リンクを作る</button>
        ${on ? '<button class="btn sm secondary" data-act="disconnect" style="margin-top:6px">この端末の接続を切る</button>' : ''}
      </details>
    </div>

    <div class="card">
      <h2>👤 名前の選択肢<span class="opt">全員共通</span></h2>
      <div class="kv">${nameLines}</div>
      <p class="note" style="margin-top:8px">リストに無い人は「その他」で名前を入力できます。追加・変更は管理者へ。</p>
    </div>

    <div class="card">
      <h2>📱 ホーム画面に入れる</h2>
      <p class="note">ホーム画面に入れると、次から1タップで開けます。</p>
      <div class="row wrap" style="margin-top:8px"><button class="btn sm secondary" data-act="copy-url">アプリのURLをコピー／共有</button>${state.installPrompt ? '<button class="btn sm green" data-act="install">この端末にインストール</button>' : ''}</div>
      <details style="margin-top:8px"><summary>ホーム画面への入れ方</summary>
        <b>iPhone（Safari）</b><ol class="steps"><li>画面下の「共有」ボタン（□に↑）をタップ</li><li>「ホーム画面に追加」をタップ</li><li>右上の「追加」</li></ol>
        <b>Android（Chrome）</b><ol class="steps"><li>右上の「⋮」をタップ</li><li>「ホーム画面に追加」または「アプリをインストール」</li></ol>
      </details>
    </div>

    <div class="card">
      <h2>📂 データ</h2>
      <div class="row wrap">
        <button class="btn sm secondary" data-act="csv">CSVで保存（${on ? '全員分' : 'この端末の分'}）</button>
        <button class="btn sm danger" data-act="wipe">この端末のデータを消す</button>
      </div>
      <p class="note" style="margin-top:8px">記録はこの端末のブラウザにも保存されています。ブラウザの「閲覧データの削除」をすると消えるので、その前に必ず送信してください。</p>
    </div>

    <div class="card small muted">
      洗浄タスク管理アプリ v${APP_VERSION} ／ <button class="sbtn" data-act="check-update" style="padding:4px 10px;font-size:12px">更新を確認</button><br>
      ${on ? '共有中' + (dbx.basePath ? '：' + esc(dbx.basePath) : '') : '未共有：このスマホの中だけに記録されています'}　<span class="mono">${esc(url)}</span>
    </div>`;
}
async function shareText(text, title) {
  try { if (navigator.share) { await navigator.share({ title, text }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('コピーしました。LINEなどに貼り付けて送ってください', 3500); }
  catch (e) { openSheet(`<h2>${esc(title)}</h2><textarea class="inp" rows="8" readonly>${esc(text)}</textarea><button class="btn secondary" data-act="close-sheet">閉じる</button>`); }
}
async function downloadFile(name, text, type) {
  try { const f = new File([text], name, { type }); if (IS_IOS && navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: name }); return; } }
  catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- 画面切替 ----------
function render() {
  viewStale = false;
  const isForm = state.tab === 'form' && D;
  if (state.tab === 'form' && !D) state.tab = 'home';
  document.body.classList.toggle('form', !!isForm);
  $('#back-btn').classList.toggle('hidden', !isForm);
  $('#tabs').classList.toggle('hidden', !!isForm);
  $('.logo').classList.toggle('hidden', !!isForm);
  $('#title').textContent = isForm ? barnOf(D.barn).label + 'の記録' + (D.editRef ? '（直す）' : '') : '洗浄タスク管理';
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  view.innerHTML = isForm ? formHtml() : ({ home: homeHtml, log: logHtml, board: boardHtml, settings: settingsHtml })[state.tab]();
  updateHeader();
}
/** 同期で内容が変わったときの描き直し。入力中（フォーム・設定・シート表示中）は邪魔せず、スクロール位置も保つ */
function refreshView() {
  const a = document.activeElement;
  const typing = a && view.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  if (state.tab === 'form' || state.tab === 'settings' || sheetOpen() || typing) { viewStale = true; updateHeader(); return; }
  rerenderKeep();
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.logLimit = 100; render(); window.scrollTo(0, 0); }));
$('#back-btn').addEventListener('click', leaveForm);

// ---------- 操作の受け口（data-act） ----------
const ACT = {
  start: (d) => { closeSheet(); startEntry(d.barn); },
  send: () => sendNow(),
  'close-sheet': () => closeSheet(),
  'goto-settings': () => { closeSheet(); state.tab = 'settings'; render(); window.scrollTo(0, 0); },
  leave: () => leaveForm(),
  save: () => saveEntry(),
  room: (d) => { const b = barnOf(D.barn); clearErr(); if (b.cols) D.room = d.v; else { const i = D.rooms.indexOf(d.v); if (i >= 0) D.rooms.splice(i, 1); else D.rooms.push(d.v); } rerenderKeep(); },
  col: (d) => { const i = D.cols.indexOf(d.v); if (i >= 0) D.cols.splice(i, 1); else D.cols.push(d.v); clearErr(); rerenderKeep(); },
  allcols: () => { const b = barnOf(D.barn); D.cols = D.cols.length === b.cols.length ? [] : b.cols.slice(); clearErr(); rerenderKeep(); },
  status: (d) => { if (D.status !== d.v) D.pct = 0; D.status = d.v; clearErr(); rerenderKeep(); },
  pct: (d) => { D.pct = +d.v; clearErr(); rerenderKeep(); },
  name: (d) => { D.nameIdx = +d.v; clearErr(); rerenderKeep(); if (D.nameIdx === namesOf(D.barn).length) { const el = $('#other-name'); if (el) el.focus(); } },
  edit: (d) => editRecord(d.id),
  void: (d) => voidRecord(d.id),
  more: () => { state.logLimit += 200; rerenderKeep(); },
  board: (d) => { state.boardBarn = d.barn; rerenderKeep(); },
  unit: (d) => showUnit(d.barn, d.room, d.col),
  'paste-go': () => {
    const m = $('#paste-link').value.match(new RegExp(HASH_KEY + '=([A-Za-z0-9_-]{20,})'));
    if (!m) { toast('招待リンクが見つかりません。LINEのメッセージをコピーして貼り付けてください', 4000); return; }
    let r; try { r = applySetup(m[1], true); } catch (e) { toast('招待リンクの読み込みに失敗：' + e.message, 5000); return; }
    if (r === 'same') { toast('すでに同じ設定で接続されています'); return; }
    if (r !== 'applied') return;
    toast('接続しました。同期します'); setupBanners(); startPolling();
    syncNow(true, true).then(() => { if (state.tab === 'settings') render(); });
  },
  invite: () => {
    const link = redirectUri() + '?openExternalBrowser=1' + setupHash(false);
    shareText(`洗浄タスク管理アプリの招待リンクです。タップして開き、「ホーム画面に追加」してください。\n${link}`, '洗浄アプリ 招待リンク');
  },
  disconnect: () => {
    const n = unsentCount();
    if (!confirm('この端末の接続を切りますか？（記録は端末に残ります）' + (n ? `\n※ 未送信が ${n}件 あります。切ると共有されません。` : ''))) return;
    Object.assign(state.cfg.dropbox, { refreshToken: '', accessToken: '', expiresAt: 0 }); state.revs = {}; persistMeta(); setSync('off'); setupBanners(); startPolling(); render();
  },
  'copy-url': () => shareText(`洗浄タスク管理アプリ\n${redirectUri()}?openExternalBrowser=1\n開いたら「ホーム画面に追加」してください。`, '洗浄アプリ'),
  install: async () => { if (!state.installPrompt) return; state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; render(); },
  csv: () => {
    if (!state.events.some((e) => e.type === 'rec')) { toast('記録がありません'); return; }
    downloadFile(`洗浄タスク_記録_${today()}.csv`, buildCsv(state.events), 'text/csv'); toast('CSVを保存しました');
  },
  wipe: () => {
    const n = unsentCount();
    if (!confirm('この端末のデータ（記録・設定）を全て消します。送信済みの記録は共有先に残ります。よろしいですか？' + (n ? `\n※ 未送信が ${n}件 あります。消すと共有されません。先に送信してください。` : ''))) return;
    for (const k of Object.values(LS)) localStorage.removeItem(k);
    location.replace(redirectUri());
  },
  'check-update': async () => {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) { await reg.update(); toast(state.swWaiting ? '新しい版があります。上の「更新」を押してください' : '最新版です'); } else toast('オフライン対応は https で開いたときに有効になります');
  },
};
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]'); if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act]; if (fn) fn(el.dataset, el, ev);
});
function onField(ev) {
  const el = ev.target; const f = el && el.dataset && el.dataset.f; if (!f || !D) return;
  if (f === 'date') D.date = el.value; else if (f === 'other') D.other = el.value; else if (f === 'memo') D.memo = el.value; else if (f === 'h' || f === 'm') D[f] = +el.value;
  clearErr();
}
document.addEventListener('input', onField); document.addEventListener('change', onField);

// ---------- 同期の表示 ----------
function syncLabel() {
  const s = state.sync;
  if (!connected()) return '端末のみ（未共有）';
  return { ok: '同期済み ' + (s.last ? fmtTime(s.last) : ''), busy: '同期中…', pending: '未送信あり', err: 'エラー: ' + s.msg, off: eventsPending() ? 'オフライン（未送信あり）' : 'オフライン' }[s.status] || s.status;
}
function setSync(status, msg = '') { state.sync.status = status; state.sync.msg = msg; if (status === 'ok') state.sync.last = Date.now(); updateHeader(); }
function updateHeader() {
  $('#sync-label').textContent = syncLabel();
  $('#sync-dot').className = 'dot ' + (connected() ? state.sync.status : 'off');
  $('#sync-btn').classList.toggle('spin', state.sync.busy);
  const n = unsentCount();
  const tb = document.querySelector('#tabs button[data-tab="home"]'); let badge = tb.querySelector('.badge');
  if (n) { if (!badge) { badge = document.createElement('span'); badge.className = 'badge'; tb.appendChild(badge); } badge.textContent = n; } else if (badge) badge.remove();
  // ホームの「未送信 n件」は入力の邪魔にならないので、その場で数字だけ直す
  const un = $('#unsent-n'); if (un && state.tab === 'home') { un.textContent = n; const btn = $('#send-btn'); if (btn) btn.disabled = !n; const card = un.closest('.send-card'); if (card) card.classList.toggle('has', !!n); }
}
$('#sync-btn').onclick = () => { if (!connected()) { state.tab = 'settings'; D = null; render(); toast('招待リンクで接続すると全員で共有できます'); } else syncNow(true); };

// ---------- バナー（LINE内ブラウザ／インストール／更新） ----------
function showBanner(html, cls = '') { const b = $('#banner'); b.className = 'banner ' + cls; b.innerHTML = html; }
function hideBanner() { $('#banner').className = 'banner hidden'; }
function setupBanners() {
  const dismissed = load(LS.dismiss, 0);
  if (state.swWaiting) {
    showBanner(`<span>新しいバージョンがあります（入力中の内容は先に記録してください）</span><button id="b-upd">更新</button>`, 'info');
    $('#b-upd').onclick = () => {
      if ((state.tab === 'form' || sheetOpen()) && !confirm('入力画面が開いています。記録していない内容は消えますが、更新しますか？')) return;
      state.updateRequested = true; state.swWaiting.postMessage('SKIP_WAITING');
    };
    return;
  }
  if (!connected()) {
    showBanner(`<span><b>まだ共有されていません。</b>LINEで届いた招待リンクを開くか、設定に貼り付けてください</span><button id="b-setup">設定を開く</button>`);
    $('#b-setup').onclick = () => { D = null; state.tab = 'settings'; render(); window.scrollTo(0, 0); };
    return;
  }
  if (IS_STANDALONE || Date.now() - dismissed < 7 * 86400e3) { hideBanner(); return; }
  const dismiss = `<button class="x" id="b-x" aria-label="閉じる">×</button>`;
  if (IS_LINE) {
    const href = redirectUri() + '?openExternalBrowser=1' + setupHash(true);     // 接続設定ごと通常のブラウザへ渡す
    showBanner(`<span>LINEの中では「ホーム画面に追加」ができません。<b>通常のブラウザで開いて</b>ください。</span><a href="${esc(href)}" target="_blank" rel="noopener"><button>ブラウザで開く</button></a>`);
  } else if (state.installPrompt) {
    showBanner(`<span>アプリとしてホーム画面に入れると次から1タップで開けます</span><button id="b-inst">インストール</button>${dismiss}`, 'info');
    $('#b-inst').onclick = async () => { state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; hideBanner(); };
  } else if (IS_IOS) {
    showBanner(`<span>Safariの <b>共有</b>（□↑）→「<b>ホーム画面に追加</b>」でアプリとして使えます</span>${dismiss}`, 'info');
  } else { hideBanner(); return; }
  const x = $('#b-x'); if (x) x.onclick = () => { save(LS.dismiss, Date.now()); hideBanner(); };
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; setupBanners(); });

// ---------- Dropbox（アプリ専用フォルダの中だけを読み書きする鍵。招待リンクで受け取る） ----------
class NetError extends Error { }
class DbxError extends Error { constructor(status, body) { let m = body; try { const j = JSON.parse(body); m = j.error_summary || (j.error && j.error['.tag']) || body; } catch (e) { } super(`${status} ${m}`); this.status = status; this.body = body; } }
async function tfetch(url, opt, ms = 30000) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null; const tm = ac ? setTimeout(() => ac.abort(), ms) : null;
  try { return await fetch(url, ac ? Object.assign({}, opt, { signal: ac.signal }) : opt); }
  catch (e) { throw new NetError(e && e.name === 'AbortError' ? '時間内に応答がありませんでした' : 'インターネットにつながりません'); }
  finally { if (tm) clearTimeout(tm); }
}
async function ensureToken() {
  const d = state.cfg.dropbox;
  if (!d.refreshToken) throw new Error('未接続');
  if (d.accessToken && Date.now() < d.expiresAt) return d.accessToken;
  const r = await tfetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: d.refreshToken, client_id: d.appKey }) });
  let j = {}; try { j = await r.json(); } catch (e) { }
  if (!r.ok) {
    if (j.error === 'invalid_grant') {         // 招待リンクが無効にされた：同じリンクを取り込み直さないよう覚えておき、未接続に戻す
      state.cfg.revoked = fingerprint(d.refreshToken); d.refreshToken = ''; d.accessToken = ''; persistMeta(); setupBanners();
      throw new Error('接続が無効になりました。新しい招待リンクをもらってください');
    }
    throw new Error(j.error_description || j.error || '認証の更新に失敗（' + r.status + '）');
  }
  d.accessToken = j.access_token; d.expiresAt = Date.now() + (j.expires_in - 60) * 1000; persistMeta();
  return d.accessToken;
}
// 通信は差し替え可能にしておく（テスト用）
const net = {
  async rpc(path, arg) {
    const token = await ensureToken();
    const r = await tfetch('https://api.dropboxapi.com/2/' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(arg) });
    if (!r.ok) throw new DbxError(r.status, await r.text());
    return r.json();
  },
  async download(path) {
    const token = await ensureToken();
    const r = await tfetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': apiArg({ path }) } });
    if (r.status === 409) { const t = await r.text(); if (t.includes('not_found')) return null; throw new DbxError(409, t); }
    if (!r.ok) throw new DbxError(r.status, await r.text());
    const meta = JSON.parse(r.headers.get('dropbox-api-result') || '{}');
    return { text: await r.text(), rev: meta.rev };
  },
  async upload(path, text) {
    const token = await ensureToken();
    const r = await tfetch('https://content.dropboxapi.com/2/files/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': apiArg({ path, mode: 'overwrite', autorename: false, mute: true }) }, body: new Blob([text]) });
    if (!r.ok) throw new DbxError(r.status, await r.text());
    return r.json();
  },
};
async function dbxList(path) {
  try {
    let r = await net.rpc('files/list_folder', { path, recursive: false });
    let entries = r.entries;
    while (r.has_more) { r = await net.rpc('files/list_folder/continue', { cursor: r.cursor }); entries = entries.concat(r.entries); }
    return entries.filter((e) => e['.tag'] === 'file');
  } catch (e) { if (e.status === 409 && /not_found/.test(e.body)) return []; throw e; }
}

// ---------- 同期 ----------
let syncTimer, pollTimer;
function scheduleSync() { if (!connected()) return; clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(false), 1200); }

/**
 * 同期の本体。戻り値 true = 取込・送信とも完了（エラーなし）。
 * 「同期済み」は「読込・検証・端末保存・必要な送信が全て完了し、未送信がない」ときだけ。
 */
async function syncNow(manual, quiet) {
  if (!connected() || state.sync.busy) return false;
  if (navigator.onLine === false) { setSync('off'); return false; }
  state.sync.busy = true; setSync('busy');
  const errors = []; let got = 0, sharedChanged = false;
  try {
    const base = basePath();
    reloadEventsFromStorage();
    // 1) 他端末の記録を取り込む（変更のあったファイルだけ。全件検証して通ったものだけ反映し、rev は保存成功後に進める）
    const files = (await dbxList(base + DIR)).filter((f) => /\.json$/i.test(f.name));
    for (const f of files) {
      if (state.revs[f.path_lower] === f.rev) continue;
      try {
        const dl = await net.download(f.path_lower); if (!dl) continue;
        const arr = validateEvents(JSON.parse(dl.text));
        const m = mergeEvents(state.events, arr);
        if (m.added) { validateEvents(m.events); writeLS(LS.events, m.events); state.events = m.events; got += m.added; }   // 保存できてから反映
        const nextRevs = Object.assign({}, state.revs, { [f.path_lower]: dl.rev }); writeLS(LS.revs, nextRevs); state.revs = nextRevs;
      } catch (e) { if (e instanceof NetError) throw e; errors.push(`${f.name}: ${e.message}`); }
    }
    // 2) この端末の記録を書く（自分のファイルだけ）。送った内容の指紋とIDを記録し、送信中に増えた分は未送信として残す
    const myPath = `${base}${DIR}/${deviceId}.json`;
    const remoteMine = files.find((f) => f.path_lower === myPath.toLowerCase());
    const own = ownEvents();
    if (own.length && (eventsPending() || !remoteMine)) {
      const text = JSON.stringify(own);
      const up = await net.upload(myPath, text);
      state.revs[myPath.toLowerCase()] = up.rev; state.sent = { fp: fingerprint(text), ids: own.map((e) => e.id), base };
    }
    // 3) 共有設定（名前の選択肢・注意ポイント）。読むだけ。更新はパソコンのツールから
    const sharedPath = (base + SHARED_FILE).toLowerCase();
    const meta = (await dbxList(base)).find((f) => f.path_lower === sharedPath);
    if (meta && state.revs[sharedPath] !== meta.rev) {
      try {
        const dl = await net.download(sharedPath);
        if (dl) {
          const v = validateShared(JSON.parse(dl.text));
          if (JSON.stringify(v) !== JSON.stringify(state.shared)) { writeLS(LS.shared, v); state.shared = v; sharedChanged = true; }
          state.revs[sharedPath] = dl.rev;
        }
      } catch (e) { if (e instanceof NetError) throw e; errors.push(`shared.json: ${e.message}`); }
    }
    persistMeta();
    if (errors.length) setSync('err', errors[0] + (errors.length > 1 ? ` 他${errors.length - 1}件` : ''));
    else if (eventsPending()) { setSync('pending'); scheduleSync(); }
    else setSync('ok');
    if (manual && !quiet) toast(errors.length ? '一部のファイルを取り込めませんでした：' + errors[0] : (got ? `他の端末の記録 ${got}件 を取り込みました` : (state.sync.status === 'pending' ? '送信待ちがあります。もう一度同期します' : '最新の状態です')), errors.length ? 6000 : 2400);
    if (got || sharedChanged) refreshView();        // 変化があったときだけ描き直す（入力中は邪魔しない）
    return errors.length === 0 && state.sync.status === 'ok';
  } catch (e) {
    console.warn('同期できませんでした', e);
    if (e instanceof NetError) setSync('off', e.message); else setSync('err', e.message);
    if (manual && !quiet) toast((e instanceof NetError ? '' : '同期エラー：') + e.message, 6000);
    return false;
  } finally { state.sync.busy = false; updateHeader(); }
}
function startPolling() {
  clearInterval(pollTimer);
  if (!connected()) return;
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') syncNow(false); }, Math.max(10, state.cfg.pollSec) * 1000);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { syncNow(false); if (navigator.serviceWorker) navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => { }); } });
window.addEventListener('online', () => syncNow(false));
window.addEventListener('offline', () => { if (connected()) setSync('off'); });

/** 「送信する」ボタン：結果をはっきり画面に出す */
const waitIdle = async () => { for (let i = 0; i < 400 && state.sync.busy; i++) await new Promise((r) => setTimeout(r, 100)); };
let sending = false;
async function sendNow() {
  if (sending) return;
  const stay = '記録はこの端末に残っています。';
  const fail = (msg, extra = '') => openSheet(`<h2>📤 送信</h2><div class="errmsg">⚠️ まだ送信できていません</div><p>${msg}</p>${extra}<button class="btn secondary" data-act="close-sheet">閉じる（あとで送信）</button>`);
  if (!connected()) { fail('この端末は、まだ共有の設定がされていません。LINEで届いた<b>招待リンク</b>を開くか、設定に貼り付けてください。' + stay, '<button class="btn" data-act="goto-settings">設定を開く</button>'); return; }
  sending = true; sheetLocked = true;
  try {
    openSheet(`<h2>📤 送信</h2><p>送信しています…</p>`);
    await waitIdle();
    const before = unsentCount();
    await syncNow(true, true);
    const n = unsentCount(); const s = state.sync;
    const retry = '<button class="btn green" data-act="send">📤 もう一度送信する</button>';
    if (n === 0 && s.status !== 'off') {
      openSheet(`<h2>📤 送信</h2><p style="font-size:18px;">✅ <b>送信しました${before ? `（${before}件）` : ''}</b></p><p>これで終わりです。おつかれさまでした。</p>${s.status === 'err' ? `<p class="note">※ 他の端末の記録の取り込みでエラーがありました：${esc(s.msg)}</p>` : ''}<button class="btn secondary" data-act="close-sheet">閉じる</button>`);
    } else if (!connected()) fail(esc(s.msg || '接続が無効になりました。新しい招待リンクをもらってください') + '。' + stay);
    else if (s.status === 'off') fail('電波が届いていないため、送信できませんでした。休憩室など<b>電波の届くところ</b>で、もう一度「送信」を押してください。' + stay, retry);
    else fail('送信できませんでした（' + esc(s.msg || '原因不明') + '）。少し待って、もう一度「送信」を押してください。' + stay, retry);
    if (state.tab !== 'form') { viewStale = false; const y = window.scrollY; view.innerHTML = ({ home: homeHtml, log: logHtml, board: boardHtml, settings: settingsHtml })[state.tab](); window.scrollTo(0, y); updateHeader(); }
  } finally { sending = false; sheetLocked = false; }
}

// ---------- 招待リンク（#senjo=...） ----------
/** 接続設定の中身。personal=true は「同じ人の別の保存領域」へ渡す用（前回の名前も入れる） */
function setupPayload(personal) {
  const d = state.cfg.dropbox;
  const p = { v: 1, app: HASH_KEY, appKey: d.appKey, basePath: d.basePath || '', refreshToken: d.refreshToken, pollSec: state.cfg.pollSec };
  if (personal) { p.me = state.cfg.lastName || ''; p.meOther = !!state.cfg.lastNameOther; }
  return p;
}
const setupHash = (personal) => (connected() ? '#' + HASH_KEY + '=' + b64url(new TextEncoder().encode(JSON.stringify(setupPayload(personal)))) : '');

/** 招待リンクの中身を取り込む。戻り値 'applied'（取り込んだ）/ 'same'（すでに同じ設定）/ 'skipped'（上書きを断った）。不正なら例外 */
function applySetup(encoded, manual) {
  let p; try { p = JSON.parse(new TextDecoder().decode(unb64url(encoded))); } catch (e) { throw new Error('リンクが途中で切れているか、内容が不正です'); }
  if (!p || p.app !== HASH_KEY) throw new Error('洗浄アプリの招待リンクではありません');
  if (typeof p.appKey !== 'string' || typeof p.refreshToken !== 'string' || !p.appKey || !p.refreshToken) throw new Error('リンクの内容が不正です');
  const d = state.cfg.dropbox;
  const base = typeof p.basePath === 'string' && (p.basePath === '' || p.basePath.startsWith('/')) ? p.basePath.replace(/\/+$/, '') : '';
  if (d.refreshToken === p.refreshToken && d.appKey === p.appKey && basePath() === base) return 'same';
  // 無効になったリンクを起動URLから自動で取り込み直さない（手で貼り付けた場合は試せる）
  if (!manual && state.cfg.revoked && state.cfg.revoked === fingerprint(p.refreshToken)) throw new Error('この招待リンクは無効になっています。新しいリンクをもらってください');
  if (d.refreshToken && !confirm('すでに接続があります。招待リンクの設定で上書きしますか？')) return 'skipped';
  Object.assign(d, { appKey: p.appKey, basePath: base, refreshToken: p.refreshToken, accessToken: '', expiresAt: 0 });
  if (Number.isInteger(p.pollSec) && p.pollSec >= 10) state.cfg.pollSec = p.pollSec;
  if (typeof p.me === 'string' && p.me && p.me.length <= 50 && !state.cfg.lastName) { state.cfg.lastName = p.me; state.cfg.lastNameOther = !!p.meOther; }
  state.cfg.revoked = ''; state.revs = {}; persistMeta();
  return 'applied';
}
function handleSetupLink() {
  const m = location.hash.match(new RegExp('^#' + HASH_KEY + '=([A-Za-z0-9_-]+)')); if (!m) return;
  // iPhone のホーム画面アプリは、起動URLに接続設定が付いたまま毎回開く。接続済みなら何もしない
  if (IS_IOS && IS_STANDALONE && connected()) { history.replaceState(null, '', redirectUri()); return; }
  try { if (applySetup(m[1]) === 'applied') toast('共有の設定を取り込みました', 3500); }
  catch (e) { toast('招待リンクの読み込みに失敗：' + e.message, 5000); }
  history.replaceState(null, '', redirectUri());
}
/**
 * iPhone/iPad の Safari では、接続設定を URL（#senjo=…）に残しておく。
 * 「ホーム画面に追加」で作られるアプリは Safari と保存領域が別なので、起動URLから設定を引き継がせるため。
 * manifest があると起動URLが固定されるので、接続済みのときは外す（＝今のURLがホーム画面に登録される）。
 */
function syncAddressBar() {
  if (!IS_IOS || IS_STANDALONE) return;
  const hash = setupHash(true);
  const want = redirectUri() + hash;
  if (location.href !== want) history.replaceState(null, '', want);
  const link = document.querySelector('link[rel="manifest"]');
  if (hash && link) link.remove();
}

// サービスワーカー（オフライン対応＋更新は「更新」ボタンを押したときだけ）
async function initSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    const hadController = !!navigator.serviceWorker.controller;      // 以前の版がこの画面を制御していたか（初回インストールと更新を区別する）
    const reg = await navigator.serviceWorker.register('sw.js');
    const track = (w) => { if (!w) return; w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) { state.swWaiting = w; setupBanners(); } }); };
    if (reg.waiting && navigator.serviceWorker.controller) { state.swWaiting = reg.waiting; setupBanners(); }
    track(reg.installing); reg.addEventListener('updatefound', () => track(reg.installing));
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      if (state.updateRequested) { reloading = true; location.reload(); return; }
      if (!hadController) return;                                  // 初めて開いたときのオフライン準備。更新ではないので案内しない
      showBanner(`<span>アプリが更新されました。画面を読み込み直してください</span><button id="b-reload">再読込</button>`, 'info');
      $('#b-reload').onclick = () => { if ((state.tab !== 'form' && !sheetOpen()) || confirm('入力画面が開いています。読み込み直しますか？')) location.reload(); };
    });
    setInterval(() => reg.update().catch(() => { }), 30 * 60 * 1000);
  } catch (e) { console.warn('SW登録失敗', e); }
}

// ---------- 起動 ----------
(function main() {
  handleSetupLink();
  syncAddressBar();
  render();
  setupBanners();
  initSW();
  if (connected()) { syncNow(false); startPolling(); }
})();

// デバッグ・検証用（tools/ のテストとブラウザのコンソールから使う）
window.WS = { state, syncNow, sendNow, addEvents, derived, unsentCount, eventsPending, net, deviceId, version: APP_VERSION, setupHash, applySetup, env: { IS_IOS, IS_STANDALONE, IS_LINE } };
})();
