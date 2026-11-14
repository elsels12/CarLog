/**
 * CarLog beta 0.9.25 — Google Apps Script バックエンド
 *
 * スプレッドシート構成:
 *   1枚目「記録」…経費レコード
 *   「車両」「点検間隔」「費目」「ゴミ箱」
 *
 * 安全対策:
 *  - 全セルをテキストとして保存（数式インジェクション防止: 先頭 ' と書式 @）
 *  - LockService で同時書き込みを排他
 *  - 安定ID（空IDの手入力行にも内容ベースのID）
 *  - 削除はゴミ箱へ退避（90日保持）
 *  - doGet は getDisplayValues() を使用
 */

var TRASH_RETENTION_DAYS = 90;

var RECORD_HEADERS = [
  'ID','車両','日付','カテゴリ','サブカテゴリ','金額','走行距離','メモ',
  '給油L','単価','満タン','重量税','自賠責','印紙代','整備費','端末ID','更新日時','カテゴリID','油種'
];
var VEHICLE_HEADERS = [
  'ID','名前','排気量cc','燃料','初度登録','車両重量kg','軽自動車','エコカー',
  '現在距離','次回車検','自賠責月数','更新日時'
];
var INTERVAL_HEADERS = ['ID','車両ID','名称','カテゴリ','サブカテゴリ','間隔km','間隔月','更新日時','削除','前回日付','前回km'];
var CATEGORY_HEADERS = ['ID','名前','アイコン','色','サブカテゴリ','点検km','点検月','削除','更新日時','スタイル','サイズ'];

function getSs_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getOrCreateSheet_(name, headers) {
  var ss = getSs_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  }
  return sh;
}

function getRecordSheet_() {
  var ss = getSs_();
  var sh = ss.getSheetByName('記録');
  if (!sh) {
    // 未命名の1枚目を「記録」として使う（新規スプレッドシート向け）
    sh = ss.getSheets()[0];
    if (sh.getLastRow() === 0 && (sh.getName() === 'シート1' || sh.getName() === 'Sheet1')) {
      sh.setName('記録');
    } else if (sh.getName() !== '記録') {
      sh = ss.insertSheet('記録', 0);
    }
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(RECORD_HEADERS);
    sh.getRange(1, 1, 1, RECORD_HEADERS.length).setFontWeight('bold');
    sh.getRange(1, 1, sh.getMaxRows(), RECORD_HEADERS.length).setNumberFormat('@');
  }
  return ensureHeaders_(sh, RECORD_HEADERS);
}

function getVehicleSheet_() { return getOrCreateSheet_('車両', VEHICLE_HEADERS); }
function ensureHeaders_(sh, headers) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var cur = sh.getRange(1, 1, 1, Math.max(lastCol, headers.length)).getDisplayValues()[0];
  var need = false;
  for (var i = 0; i < headers.length; i++) {
    if (String(cur[i] || '').trim() !== headers[i]) { need = true; break; }
  }
  if (need) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  }
  return sh;
}
function getIntervalSheet_() {
  return ensureHeaders_(getOrCreateSheet_('点検間隔', INTERVAL_HEADERS), INTERVAL_HEADERS);
}
function getCategorySheet_() { return ensureHeaders_(getOrCreateSheet_('費目', CATEGORY_HEADERS), CATEGORY_HEADERS); }

function getTrashSheet_() {
  var ss = getSs_();
  var trash = ss.getSheetByName('ゴミ箱');
  if (!trash) {
    trash = ss.insertSheet('ゴミ箱');
    var headers = RECORD_HEADERS.concat(['削除日時']);
    trash.appendRow(headers);
    trash.getRange(1, 1, trash.getMaxRows(), headers.length).setNumberFormat('@');
  }
  return ensureHeaders_(trash, RECORD_HEADERS.concat(['削除日時']));
}

function txt_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  if (s === '') return '';
  if (s.charAt(0) === "'") return s;
  if (/^[=+\-@]/.test(s) || (s.trim() !== '' && !isNaN(Number(s)))) return "'" + s;
  return s;
}

function clean_(v) {
  return String(v || '').trim().replace(/^'/, '');
}

function parseTime_(v, fallback) {
  if (!v) return (fallback !== undefined ? fallback : 0);
  var t = new Date(v).getTime();
  return isNaN(t) ? (fallback !== undefined ? fallback : 0) : t;
}

function rowKey_(row) {
  var raw = clean_(row[0]);
  if (raw) return raw;
  return 'manual_' + clean_(row[2]) + '_' + clean_(row[1]) + '_' + clean_(row[3]) + '_' + clean_(row[5]) + '_' + clean_(row[6]);
}

function buildRecordRow_(entry) {
  var safeUpdated = entry.updatedAt;
  if (!safeUpdated || isNaN(new Date(safeUpdated).getTime())) {
    safeUpdated = new Date().toISOString();
  }
  return [
    String(entry.id || ''),
    txt_(entry.vehicle || entry.vehicleName || ''),
    txt_(entry.date || ''),
    txt_(entry.category || ''),
    txt_(entry.subcategory || ''),
    txt_(entry.amount),
    txt_(entry.odometer),
    txt_(entry.memo || ''),
    txt_(entry.liters),
    txt_(entry.unitPrice),
    txt_(entry.isFullTank === true || entry.isFullTank === '1' || entry.isFullTank === 'true' ? '1' : ''),
    txt_(entry.weightTax),
    txt_(entry.liability),
    txt_(entry.stampFee),
    txt_(entry.serviceFee),
    String(entry.deviceId || ''),
    String(safeUpdated),
    txt_(entry.categoryId || ''),
    txt_(entry.fuelGrade || '')
  ];
}

function rowToEntry_(row) {
  var amount = parseFloat(clean_(row[5]));
  var odo = parseFloat(clean_(row[6]));
  var liters = parseFloat(clean_(row[8]));
  var unit = parseFloat(clean_(row[9]));
  function n(v) { var x = parseFloat(clean_(v)); return isNaN(x) ? null : x; }
  var full = clean_(row[10]);
  return {
    id: rowKey_(row),
    vehicle: clean_(row[1]),
    date: clean_(row[2]),
    category: clean_(row[3]),
    subcategory: clean_(row[4]),
    amount: isNaN(amount) ? null : amount,
    odometer: isNaN(odo) ? null : odo,
    memo: clean_(row[7]) || '',
    liters: isNaN(liters) ? null : liters,
    unitPrice: isNaN(unit) ? null : unit,
    isFullTank: full === '1' || full === 'true' || full === 'TRUE',
    weightTax: n(row[11]),
    liability: n(row[12]),
    stampFee: n(row[13]),
    serviceFee: n(row[14]),
    deviceId: clean_(row[15]) || null,
    updatedAt: clean_(row[16]) || '',
    categoryId: clean_(row[17]) || '',
    fuelGrade: clean_(row[18]) || ''
  };
}

function buildVehicleRow_(v) {
  return [
    String(v.id || ''),
    txt_(v.name || ''),
    txt_(v.displacementCc),
    txt_(v.fuelType || 'gasoline'),
    txt_(v.registeredYm || ''),
    txt_(v.weightKg),
    txt_(v.isKei ? '1' : ''),
    txt_(v.isEco ? '1' : ''),
    txt_(v.currentOdometer),
    txt_(v.nextShakenDate || ''),
    txt_(v.jibaisekiMonths || 24),
    String(v.updatedAt || new Date().toISOString())
  ];
}

function rowToVehicle_(row) {
  function n(v) { var x = parseFloat(clean_(v)); return isNaN(x) ? null : x; }
  function flag(v) { var s = clean_(v); return s === '1' || s === 'true' || s === 'TRUE'; }
  return {
    id: clean_(row[0]),
    name: clean_(row[1]),
    displacementCc: n(row[2]),
    fuelType: clean_(row[3]) || 'gasoline',
    registeredYm: clean_(row[4]),
    weightKg: n(row[5]),
    isKei: flag(row[6]),
    isEco: flag(row[7]),
    currentOdometer: n(row[8]),
    nextShakenDate: clean_(row[9]) || '',
    jibaisekiMonths: n(row[10]) || 24,
    updatedAt: clean_(row[11]) || ''
  };
}

function buildIntervalRow_(it) {
  return [
    String(it.id || ''),
    txt_(it.vehicleId || ''),
    txt_(it.label || ''),
    txt_(it.category || ''),
    txt_(it.subcategory || ''),
    txt_(it.km),
    txt_(it.months),
    String(it.updatedAt || new Date().toISOString()),
    txt_(it.deleted ? '1' : ''),
    txt_(it.lastReplacedDate || ''),
    txt_(it.lastReplacedOdo)
  ];
}

function rowToInterval_(row) {
  function n(v) { var x = parseFloat(clean_(v)); return isNaN(x) ? null : x; }
  return {
    id: clean_(row[0]),
    vehicleId: clean_(row[1]) || '',
    label: clean_(row[2]),
    category: clean_(row[3]),
    subcategory: clean_(row[4]),
    km: n(row[5]),
    months: n(row[6]),
    updatedAt: clean_(row[7]) || '',
    deleted: (function (v) { var s = clean_(v); return s === '1' || s === 'true' || s === 'TRUE'; })(row[8]),
    lastReplacedDate: clean_(row[9]) || '',
    lastReplacedOdo: n(row[10])
  };
}



function splitStyle_(s) {
  s = String(s == null ? '' : s).trim();
  var base = s, op = null;
  var m = s.match(/^(.*?)[:：](\d{1,3})$/);
  if (m) { base = m[1].trim(); op = parseInt(m[2], 10); }
  if (op != null && (isNaN(op) || op < 10 || op > 100)) op = null;
  var style = '';
  if (base === 'fill' || base === '塗り') style = 'fill';
  else if (base === 'line' || base === '線') style = 'line';
  return { style: style, opacity: op };
}
function styleText_(s, opacity) {
  var st = splitStyle_(s);
  var style = st.style;
  var label = style === 'fill' ? '塗り' : (style === 'line' ? '線' : '');
  var op = opacity != null && opacity !== '' ? parseInt(opacity, 10) : st.opacity;
  if (label && op != null && !isNaN(op)) {
    if (op < 10) op = 10;
    if (op > 100) op = 100;
    return label + ':' + op;
  }
  return label;
}
function styleFrom_(s) {
  return splitStyle_(s).style;
}
function opacityFrom_(s) {
  return splitStyle_(s).opacity;
}

function buildCategoryRow_(c) {
  var subs = c.subs;
  if (Array.isArray(subs)) subs = subs.join('|');
  return [
    String(c.id || ''),
    txt_(c.name || ''),
    txt_(c.icon || 'star'),
    txt_(c.color || ''),
    txt_(subs || ''),
    txt_(c.alertKm),
    txt_(c.alertMonths),
    txt_(c.deleted ? '1' : ''),
    String(c.updatedAt || new Date().toISOString()),
    txt_(styleText_(c.style, c.opacity)),
    txt_(c.size || '')
  ];
}
function rowToCategory_(row) {
  function n(v) { var x = parseFloat(clean_(v)); return isNaN(x) ? null : x; }
  function flag(v) { var s = clean_(v); return s === '1' || s === 'true' || s === 'TRUE'; }
  var subs = clean_(row[4]);
  return {
    id: clean_(row[0]),
    name: clean_(row[1]),
    icon: clean_(row[2]) || 'star',
    color: clean_(row[3]) || '',
    subs: subs ? subs.split('|').filter(function(x){ return x; }) : [],
    alertKm: n(row[5]),
    alertMonths: n(row[6]),
    deleted: flag(row[7]),
    updatedAt: clean_(row[8]) || '',
    style: styleFrom_(row[9]),
    opacity: opacityFrom_(row[9]),
    size: clean_(row[10]) || ''
  };
}

function upsertById_(sheet, colCount, incoming, buildRow, getIdFromDisplayRow, idOf, updatedIdx) {
  var lastRow = sheet.getLastRow();
  var toAppend = [];
  var updated = 0, skipped = 0;
  var uidx = (updatedIdx == null) ? (colCount - 1) : updatedIdx;
  if (lastRow > 1) {
    var allValues = sheet.getRange(2, 1, lastRow - 1, colCount).getValues();
    var allDisplay = sheet.getRange(2, 1, lastRow - 1, colCount).getDisplayValues();
    var idMap = {};
    for (var i = 0; i < allDisplay.length; i++) {
      var idStr = getIdFromDisplayRow(allDisplay[i]);
      if (idStr) idMap[idStr] = i;
    }
    var changed = {};
    incoming.forEach(function (en) {
      if (!en) return;
      var row = buildRow(en);
      var entryId = idOf(en);
      if (entryId && idMap[entryId] !== undefined) {
        var rowIdx = idMap[entryId];
        var existingUpdate = parseTime_(clean_(allDisplay[rowIdx][uidx]), 0);
        var incomingUpdate = parseTime_(en.updatedAt, 0);
        if (incomingUpdate >= existingUpdate || existingUpdate === 0) {
          allValues[rowIdx] = row;
          changed[rowIdx] = true;
          updated++;
        } else {
          skipped++;
        }
      } else {
        toAppend.push(row);
      }
    });
    var keys = Object.keys(changed);
    if (keys.length > 0 && keys.length <= 40) {
      keys.forEach(function (k) {
        var ri = Number(k);
        sheet.getRange(ri + 2, 1, 1, colCount).setValues([allValues[ri]]);
      });
    } else if (keys.length > 0) {
      sheet.getRange(2, 1, allValues.length, colCount).setValues(allValues);
    }
  } else {
    incoming.forEach(function (en) { if (en) toAppend.push(buildRow(en)); });
  }
  if (toAppend.length > 0) {
    var start = sheet.getLastRow() + 1;
    sheet.getRange(start, 1, toAppend.length, colCount).setValues(toAppend);
  }
  return { updated: updated, appended: toAppend.length, skipped: skipped };
}

function purgeOldTrash_(days) {
  try {
    var trash = getSs_().getSheetByName('ゴミ箱');
    if (!trash) return;
    var lastRow = trash.getLastRow();
    if (lastRow <= 1) return;
    var limitMs = (days || 90) * 24 * 60 * 60 * 1000;
    var now = Date.now();
    var col = RECORD_HEADERS.length + 1;
    var values = trash.getRange(2, col, lastRow - 1, 1).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      var t = new Date(values[i][0]).getTime();
      if (!isNaN(t) && (now - t) > limitMs) trash.deleteRow(i + 2);
    }
  } catch (err) {}
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var data = JSON.parse(e.postData.contents);
    var sheet = getRecordSheet_();

    if (data.action === 'save' && data.entry) {
      var r = upsertById_(sheet, RECORD_HEADERS.length, [data.entry], buildRecordRow_, rowKey_, function (en) {
        return String(en.id || '').trim().replace(/^'/, '');
      }, 16);
      return jsonOut_({ status: 'ok', updated: r.updated > 0, skipped: r.skipped > 0 });
    }

    if (data.action === 'bulk_upload' && Array.isArray(data.entries)) {
      var byId = {}, noId = [];
      data.entries.forEach(function (en) {
        if (!en) return;
        var k = String(en.id || '').trim().replace(/^'/, '');
        if (!k) { noId.push(en); return; }
        var cur = byId[k];
        var enTime = parseTime_(en.updatedAt, 0);
        var curTime = cur ? parseTime_(cur.updatedAt, 0) : -1;
        if (!cur || enTime >= curTime) byId[k] = en;
      });
      var list = Object.keys(byId).map(function (k) { return byId[k]; }).concat(noId);
      var r2 = upsertById_(sheet, RECORD_HEADERS.length, list, buildRecordRow_, rowKey_, function (en) {
        return String(en.id || '').trim().replace(/^'/, '');
      }, 16);
      return jsonOut_({ status: 'ok', updated: r2.updated, appended: r2.appended, skipped: r2.skipped });
    }

    if (data.action === 'delete' && data.id) {
      deleteRecords_([data.id]);
      return jsonOut_({ status: 'ok' });
    }

    if (data.action === 'bulk_delete' && Array.isArray(data.ids) && data.ids.length > 0) {
      deleteRecords_(data.ids);
      return jsonOut_({ status: 'ok' });
    }

    if (data.action === 'save_vehicles' && Array.isArray(data.vehicles)) {
      var vs = getVehicleSheet_();
      var r3 = upsertById_(vs, VEHICLE_HEADERS.length, data.vehicles, buildVehicleRow_, function (row) {
        return clean_(row[0]);
      }, function (v) { return String(v.id || '').trim().replace(/^'/, ''); });
      return jsonOut_({ status: 'ok', updated: r3.updated, appended: r3.appended, skipped: r3.skipped });
    }

    if (data.action === 'save_intervals' && Array.isArray(data.intervals)) {
      var ish = getIntervalSheet_();
      var r4 = upsertById_(ish, INTERVAL_HEADERS.length, data.intervals, buildIntervalRow_, function (row) {
        return clean_(row[0]);
      }, function (v) { return String(v.id || '').trim().replace(/^'/, ''); }, 7);
      return jsonOut_({ status: 'ok', updated: r4.updated, appended: r4.appended, skipped: r4.skipped });
    }

    if (data.action === 'save_categories' && Array.isArray(data.categories)) {
      var csh = getCategorySheet_();
      var r5 = upsertById_(csh, CATEGORY_HEADERS.length, data.categories, buildCategoryRow_, function (row) {
        return clean_(row[0]);
      }, function (v) { return String(v.id || '').trim().replace(/^'/, ''); }, 8);
      return jsonOut_({ status: 'ok', updated: r5.updated, appended: r5.appended, skipped: r5.skipped });
    }

    return jsonOut_({ status: 'unknown_action' });
  } catch (err) {
    return jsonOut_({ status: 'error', message: err.toString() });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function deleteRecords_(ids) {
  var sheet = getRecordSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var idSet = {};
  ids.forEach(function (id) { idSet[String(id).trim().replace(/^'/, '')] = true; });
  var colN = Math.max(17, Math.min(RECORD_HEADERS.length, sheet.getLastColumn() || 17));
  var display = sheet.getRange(2, 1, lastRow - 1, colN).getDisplayValues();
  var values = sheet.getRange(2, 1, lastRow - 1, colN).getValues();
  var rowsToTrash = [];
  var rowsToDelete = [];
  var nowIso = new Date().toISOString();
  for (var i = 0; i < display.length; i++) {
    var rowId = rowKey_(display[i]);
    if (idSet[rowId]) {
      var r = values[i].map(function (v, c) {
        return typeof v === 'string' ? txt_(v) : v;
      });
      r.push(nowIso);
      rowsToTrash.push(r);
      rowsToDelete.push(i + 2);
    }
  }
  if (rowsToTrash.length > 0) {
    var trash = getTrashSheet_();
    var start = trash.getLastRow() + 1;
    trash.getRange(start, 1, rowsToTrash.length, rowsToTrash[0].length).setValues(rowsToTrash);
  }
  for (var d = rowsToDelete.length - 1; d >= 0; d--) sheet.deleteRow(rowsToDelete[d]);
  purgeOldTrash_(TRASH_RETENTION_DAYS);
}

function readSheet_(sheet, colCount, mapper) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, colCount).getDisplayValues();
  return values.map(mapper);
}

function doGet(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    var recSheet = getRecordSheet_();
    var recCols = Math.max(17, Math.min(RECORD_HEADERS.length, recSheet.getLastColumn() || 17));
    var entries = readSheet_(recSheet, recCols, rowToEntry_);
    var vehicles = [];
    var intervals = [];
    var categories = [];
    try { vehicles = readSheet_(getVehicleSheet_(), VEHICLE_HEADERS.length, rowToVehicle_); } catch (err) {}
    try {
      var ishGet = getIntervalSheet_();
      var icols = Math.max(8, Math.min(INTERVAL_HEADERS.length, ishGet.getLastColumn() || 8));
      intervals = readSheet_(ishGet, icols, rowToInterval_);
    } catch (err2) {}
    try {
      var csh = getCategorySheet_();
      var ccols = Math.max(9, Math.min(CATEGORY_HEADERS.length, csh.getLastColumn() || 9));
      categories = readSheet_(csh, ccols, rowToCategory_);
    } catch (err3) {}
    return jsonOut_({ status: 'ok', entries: entries, vehicles: vehicles, intervals: intervals, categories: categories });
  } catch (err) {
    return jsonOut_({ status: 'error', message: err.toString() });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function cleanupTrash() {
  purgeOldTrash_(TRASH_RETENTION_DAYS);
}
