/* 洗浄タスク管理アプリ  共通ロジック（画面に依存しない部分）
 * ブラウザでは window.WSCore、Node では module.exports として使える。tools/test_core.js で単体テストする。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WSCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ---------- 場所と状態（Excel「洗浄タスク管理アプリ」シートのとおり） ----------
  const WASHING = { key: 'washing', label: '洗浄途中', pcts: [25, 50, 75] };
  const ROOM_STATUSES = [WASHING, { key: 'washed', label: '洗浄終了' }, { key: 'finished', label: '洗浄最後の仕上げ完了' },
    { key: 'helmin', label: 'ヘルミン消毒完了' }, { key: 'lime', label: '石灰消毒完了' }];
  const BARNS = [
    { key: 'bunben', label: '分娩舎', icon: '🐖', sub: '1〜6番・列ごと', rooms: ['1', '2', '3', '4', '5', '6'], suffix: '番', cols: ['1', '2', '3', '4'], perRow: 3,
      statuses: [WASHING, { key: 'washed', label: '洗浄完了' }, { key: 'disinfected', label: '消毒完了' }] },
    { key: 'rinyu', label: '離乳舎', icon: '🐽', sub: '1〜20番・部屋ごと', rooms: Array.from({ length: 20 }, (_, i) => String(i + 1)), suffix: '番', perRow: 5, statuses: ROOM_STATUSES },
    { key: 'tsuro', label: '離乳舎の通路', icon: '🚿', sub: '子豚移動後', rooms: null, statuses: [{ key: 'washed', label: '洗浄完了' }] },
    { key: 'hiiku', label: '肥育舎', icon: '🐷', sub: 'A1〜D4の16室・部屋ごと', rooms: ['A', 'B', 'C', 'D'].flatMap((a) => [1, 2, 3, 4].map((n) => a + n)), suffix: '', perRow: 4, statuses: ROOM_STATUSES },
  ];
  const STATUS_SHORT = { washing: '途中', washed: '洗浄済', finished: '仕上げ済', helmin: 'ヘルミン済', lime: '石灰済', disinfected: '消毒済' };
  const TSURO_ROOM = '通路';
  const DEFAULT_CAUTIONS = ['餌ホッパーの目盛りシールに、高圧の水を強く当てない（はがれてしまいます）'];
  const MAX_MINUTES = 24 * 60;

  const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
  const isId = (v) => typeof v === 'string' && ID_RE.test(v);
  const isInt = (v) => Number.isSafeInteger(v);
  const isStr = (v, max) => typeof v === 'string' && v.length <= max;

  const barnOf = (k) => BARNS.find((b) => b.key === k) || null;
  const statusOf = (barnKey, key) => { const b = barnOf(barnKey); return (b && b.statuses.find((s) => s.key === key)) || null; };
  function dateOK(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z'); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  function unitLabel(barnKey, room, col) {
    const b = barnOf(barnKey); if (!b) return String(room || '');
    if (!b.rooms) return TSURO_ROOM;
    return room + (b.suffix || '') + (col ? ' ' + col + '列' : '');
  }
  /** 例: 分娩舎 3番 1・2列 ／ 肥育舎 A1・A2 ／ 離乳舎の通路（子豚移動後） */
  function placeLabel(r) {
    const b = barnOf(r.barn); if (!b) return '';
    if (!b.rooms) return b.label + '（' + b.sub + '）';
    if (b.cols) return b.label + ' ' + r.units[0].room + b.suffix + ' ' + r.units.map((u) => u.col).join('・') + '列';
    return b.label + ' ' + r.units.map((u) => u.room + b.suffix).join('・');
  }
  function statusText(r) { const st = statusOf(r.barn, r.status); return (st ? st.label : r.status) + (r.status === 'washing' ? ' ' + r.pct + '%' : ''); }

  /** 文字列の指紋（FNV-1a 32bit + 長さ）。送信済み内容と現在値の比較に使う */
  function fingerprint(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0') + ':' + str.length;
  }

  /** 1件の場所（units）がその畜舎として正しいか */
  function unitsOK(b, units) {
    if (!Array.isArray(units) || units.length < 1 || units.length > 24) return false;
    const seen = new Set();
    for (const u of units) {
      if (!u || typeof u !== 'object' || typeof u.room !== 'string' || typeof u.col !== 'string') return false;
      const k = u.room + '|' + u.col; if (seen.has(k)) return false; seen.add(k);
      if (!b.rooms) { if (u.room !== TSURO_ROOM || u.col !== '') return false; }
      else if (!b.rooms.includes(u.room)) return false;
      else if (b.cols) { if (!b.cols.includes(u.col) || u.room !== units[0].room) return false; }
      else if (u.col !== '') return false;
    }
    return !(!b.rooms && units.length !== 1);
  }

  /** 記録ファイル全体を検証。1件でも不正なら全体を拒否する（部分反映しない） */
  function validateEvents(value) {
    if (!Array.isArray(value)) throw new Error('記録の形式が不正です（配列ではありません）');
    const seen = new Set();
    value.forEach((e, i) => {
      const bad = (why) => { throw new Error(`記録 ${i + 1}件目が不正です：${why}`); };
      if (!e || typeof e !== 'object') bad('空');
      if (!isId(e.id)) bad('ID');
      if (seen.has(e.id)) bad('ID重複 ' + e.id);
      if (!isId(e.dev)) bad('端末ID');
      if (!isInt(e.ts) || e.ts < 0) bad('日時');
      if (e.type === 'void') {
        if (!isId(e.ref)) bad('取消の参照先');
        if (e.name != null && !isStr(e.name, 50)) bad('名前');
      } else if (e.type === 'rec') {
        const b = barnOf(e.barn); if (!b) bad('畜舎');
        if (!dateOK(e.date)) bad('作業日');
        if (!unitsOK(b, e.units)) bad('場所');
        if (!b.statuses.some((s) => s.key === e.status)) bad('状態');
        if (e.status === 'washing' ? !WASHING.pcts.includes(e.pct) : e.pct !== 100) bad('進み具合');
        if (!isStr(e.name, 50) || !e.name.trim()) bad('名前');
        if (!isInt(e.minutes) || e.minutes < 1 || e.minutes > MAX_MINUTES) bad('作業時間');
        if (e.memo != null && !isStr(e.memo, 500)) bad('メモ');
      } else bad('種類');
      seen.add(e.id);
    });
    return value;
  }

  /** 共有設定（名前の選択肢・注意ポイント）。欠けている項目は既定値で補う */
  function validateShared(value) {
    const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const bad = (why) => { throw new Error('共有設定が不正です：' + why); };
    const strList = (a, max, why) => {
      if (a == null) return [];
      if (!Array.isArray(a) || a.length > 100) bad(why);
      const out = []; for (const s of a) { if (!isStr(s, max) || !s.trim()) bad(why); if (!out.includes(s.trim())) out.push(s.trim()); }
      return out;
    };
    const names = {}; const src = v.names && typeof v.names === 'object' ? v.names : {};
    for (const b of BARNS) names[b.key] = strList(src[b.key], 50, b.label + 'の名前');
    return { names, cautions: v.cautions == null ? null : strList(v.cautions, 200, '注意ポイント'), updatedAt: v.updatedAt == null ? 0 : (isInt(v.updatedAt) && v.updatedAt >= 0 ? v.updatedAt : bad('更新日時')) };
  }
  const emptyShared = () => validateShared({});
  const cautionsOf = (shared) => (shared && Array.isArray(shared.cautions) ? shared.cautions : DEFAULT_CAUTIONS);

  /** 全端末で同じ順になる並べ方（時刻→ID） */
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  function orderEvents(events) { return [...events].sort((a, b) => a.ts - b.ts || cmp(a.id, b.id)); }

  /** 記録の統合（IDで重複排除）。新しい配列と追加件数を返す。元の配列は変更しない */
  function mergeEvents(local, remote) {
    const ids = new Set(local.map((e) => e.id));
    const added = [];
    for (const e of remote) if (!ids.has(e.id)) { ids.add(e.id); added.push(e); }
    return { events: added.length ? local.concat(added) : local, added: added.length };
  }

  /** 取り消された記録のID */
  function voidedSet(events) { const s = new Set(); for (const e of events) if (e.type === 'void') s.add(e.ref); return s; }
  /** 有効な記録（取消を除く）。新しい順ではなく入力順 */
  function activeRecords(events) { const v = voidedSet(events); return orderEvents(events.filter((e) => e.type === 'rec' && !v.has(e.id))); }

  const unitKey = (barn, room, col) => barn + '|' + room + '|' + col;
  /** 場所ごとの「いちばん新しい記録」。作業日 → 入力時刻 → ID の順で新しいものを採用（全端末で同じ結果になる） */
  function latestByUnit(events) {
    const m = new Map();
    const newer = (a, b) => a.date > b.date || (a.date === b.date && (a.ts > b.ts || (a.ts === b.ts && a.id > b.id)));
    for (const r of activeRecords(events)) for (const u of r.units) {
      const k = unitKey(r.barn, u.room, u.col); const o = m.get(k);
      if (!o || newer(r, o)) m.set(k, r);
    }
    return m;
  }
  /** ある場所の記録（新しい順） */
  function recordsOfUnit(events, barn, room, col) {
    return activeRecords(events).filter((r) => r.barn === barn && r.units.some((u) => u.room === room && u.col === col))
      .sort((a, b) => cmp(b.date, a.date) || b.ts - a.ts || cmp(b.id, a.id));
  }

  // ---------- CSV（1行＝1か所。Excelでそのまま開ける） ----------
  const CSV_HEAD = ['記録ID', '取消', '作業日', '畜舎', '部屋', '列', '場所', '状態', '進捗(%)', '名前', '作業時間(分)', '同時入力の箇所数', '1か所あたり(分)', 'メモ', '入力日時', '端末ID'];
  const pad = (n) => String(n).padStart(2, '0');
  function fmtStamp(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s) && isNaN(Number(s))) s = "'" + s;      // Excelで式として動かないようにする
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toRows(events) {
    const v = voidedSet(events); const rows = [];
    for (const r of orderEvents(events.filter((e) => e.type === 'rec')).sort((a, b) => cmp(a.date, b.date) || a.ts - b.ts || cmp(a.id, b.id))) {
      const b = barnOf(r.barn); const st = statusOf(r.barn, r.status); const n = r.units.length;
      for (const u of r.units) rows.push([r.id, v.has(r.id) ? '取消' : '', r.date, b ? b.label : r.barn, u.room, u.col, unitLabel(r.barn, u.room, u.col), st ? st.label : r.status, r.pct,
        r.name, r.minutes, n, Math.round(r.minutes / n * 10) / 10, r.memo || '', fmtStamp(r.ts), r.dev]);
    }
    return rows;
  }
  function buildCsv(events) { return '﻿' + [CSV_HEAD].concat(toRows(events)).map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'; }

  /** Dropbox-API-Arg ヘッダ用：非ASCIIを \uXXXX に */
  const apiArg = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

  return { WASHING, ROOM_STATUSES, BARNS, STATUS_SHORT, TSURO_ROOM, DEFAULT_CAUTIONS, MAX_MINUTES, ID_RE, CSV_HEAD,
    barnOf, statusOf, dateOK, unitLabel, placeLabel, statusText, fingerprint, validateEvents, validateShared, emptyShared, cautionsOf,
    orderEvents, mergeEvents, voidedSet, activeRecords, unitKey, latestByUnit, recordsOfUnit, toRows, buildCsv, fmtStamp, apiArg, b64url, unb64url };
});
