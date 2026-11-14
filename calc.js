/* CarLog beta 0.9.31 — 税額・燃費・点検期限の計算（ブラウザ / Node 共用）
 * 税額はすべて「目安」。グリーン化特例・減免・月割・離島/沖縄の自賠責は含まない。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KakeLogCalc = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 自動車税（種別割）自家用乗用 年額
  // [排気量上限cc, 2019-10-01以後, 2019-09-30以前, 13年超重課]
  // 出典: 総務省「2019年10月1日、自動車の税が大きく変わります」
  //       東京都主税局 自動車税 税率表（2026-10-09 確認、日本カーネットまとめ）
  var JIDOSHA_BRACKETS = [
    [1000, 25000, 29500, 33900],
    [1500, 30500, 34500, 39600],
    [2000, 36000, 39500, 45400],
    [2500, 43500, 45000, 51700],
    [3000, 50000, 51000, 58600],
    [3500, 57000, 58000, 66700],
    [4000, 65500, 66500, 76400],
    [4500, 75500, 76500, 87900],
    [6000, 87000, 88000, 101200],
    [Infinity, 110000, 111000, 127600]
  ];

  // 軽自動車税（四輪・自家用乗用）年額
  var KEI = { after201504: 10800, before201504: 7200, heavy13: 12900 };

  // 重量税 継続検査 2年 自家用乗用 0.5t あたり
  // 出典: 国土交通省「2026年5月1日からの自動車重量税の税額表＜継続検査等時＞」
  //       （日本カーネット 2026-11-10 確認）
  var WEIGHT_PER_HALF_TON_2Y = {
    ecoHonoku: 5000,
    normal: 8200,
    y13: 11400,
    y18: 12600
  };
  var KEI_WEIGHT_2Y = { ecoHonoku: 5000, normal: 6600, y13: 8200, y18: 8800 };

  // 自賠責 自家用乗用（離島・沖縄を除く）
  // 出典: 損害保険料率算出機構 2026年4月届出（2026-11-01 始期から新料率）
  var JIBAISEKI = {
    cutoff: "2026-11-01",
    passenger: {
      12: { before: 0, after: 0 }, // 未収録
      24: { before: 17650, after: 18560 },
      25: { before: 18160, after: 19070 },
      36: { before: 23690, after: 24690 },
      37: { before: 24190, after: 25180 }
    },
    kei: {
      24: { before: 17540, after: 18660 },
      36: { before: 23520, after: 24830 }
    }
  };

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function toYm(s) {
    if (!s) return null;
    var m = String(s).match(/^(\d{4})[-/](\d{1,2})/);
    if (!m) return null;
    return { y: +m[1], m: +m[2] };
  }

  function toDate(s) {
    if (!s) return null;
    if (s instanceof Date) {
      if (isNaN(s.getTime())) return null;
      return new Date(s.getFullYear(), s.getMonth(), s.getDate());
    }
    var m = String(s).match(/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 1);
  }

  function ymd(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function addMonths(date, months) {
    var d = new Date(date.getFullYear(), date.getMonth() + months, 1);
    var day = date.getDate();
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d;
  }

  // 課税年度の4月1日（4月〜翌3月）
  function fyStart(asOf) {
    asOf = toDate(asOf) || new Date();
    var y = asOf.getFullYear();
    var m = asOf.getMonth(); // 0-11
    if (m < 3) y -= 1;
    return new Date(y, 3, 1);
  }

  function fyLabel(asOf) {
    return fyStart(asOf).getFullYear() + "年度";
  }

  // 自動車税の重課: 4月1日時点で初度登録から13年（ディーゼルは11年）を超えるもの
  // 2026年度はガソリン車で初度登録 2013年3月以前が対象
  function isJidoshaZeiHeavy(regYm, fuelType, asOf) {
    var ft = fuelType || "gasoline";
    if (ft === "ev" || ft === "hybrid" || ft === "phev" || ft === "fcv" || ft === "cng" || ft === "methanol") {
      return false;
    }
    var reg = toYm(regYm);
    if (!reg) return false;
    var years = ft === "diesel" ? 11 : 13;
    var start = fyStart(asOf);
    var cutoffY = start.getFullYear() - years;
    var cutoffM = 3; // 3月
    return reg.y < cutoffY || (reg.y === cutoffY && reg.m <= cutoffM);
  }

  function isPost201910(regYm) {
    var reg = toYm(regYm);
    if (!reg) return false;
    return reg.y > 2019 || (reg.y === 2019 && reg.m >= 10);
  }

  function jidoshaZei(opts) {
    opts = opts || {};
    var asOf = opts.asOf || new Date();
    var fuel = opts.fuelType || "gasoline";
    var result = {
      amount: 0,
      label: fyLabel(asOf),
      heavy: false,
      table: "",
      note: "目安。グリーン化特例・減免・月割は含みません。",
      ok: true
    };

    if (opts.isKei) {
      var reg = toYm(opts.registeredYm);
      var keiHeavy = false;
      if (reg) {
        // 軽は最初の新規検査から13年を経過。2026年度は2013年3月以前
        keiHeavy = isJidoshaZeiHeavy(opts.registeredYm, "gasoline", asOf) &&
          fuel !== "ev" && fuel !== "hybrid" && fuel !== "phev" && fuel !== "fcv";
      }
      if (keiHeavy) {
        result.amount = KEI.heavy13;
        result.heavy = true;
        result.table = "軽自動車・13年超重課";
      } else if (reg && (reg.y < 2015 || (reg.y === 2015 && reg.m <= 3))) {
        result.amount = KEI.before201504;
        result.table = "軽自動車・2015年3月以前";
      } else {
        result.amount = KEI.after201504;
        result.table = "軽自動車・2015年4月以後";
      }
      return result;
    }

    var cc = Number(opts.displacementCc) || 0;
    if (fuel === "ev" || fuel === "fcv") {
      // 電気・燃料電池は1.0L以下と同じ標準額、重課なし
      var evPost = isPost201910(opts.registeredYm);
      result.amount = evPost ? 25000 : 29500;
      result.table = evPost ? "EV等・2019年10月以後" : "EV等・2019年9月以前";
      result.heavy = false;
      return result;
    }
    if (!cc) {
      result.ok = false;
      result.note = "排気量を入力すると計算できます。";
      return result;
    }
    var row = null;
    for (var i = 0; i < JIDOSHA_BRACKETS.length; i++) {
      if (cc <= JIDOSHA_BRACKETS[i][0]) { row = JIDOSHA_BRACKETS[i]; break; }
    }
    var heavy = isJidoshaZeiHeavy(opts.registeredYm, fuel, asOf);
    var post = isPost201910(opts.registeredYm);
    if (heavy) {
      result.amount = row[3];
      result.heavy = true;
      result.table = "13年超重課" + (fuel === "diesel" ? "（ディーゼル11年）" : "");
    } else if (post) {
      result.amount = row[1];
      result.table = "2019年10月以後登録";
    } else {
      result.amount = row[2];
      result.table = "2019年9月以前登録";
    }
    return result;
  }

  // 重量税の13年経過: 初度登録から12年10か月がたった月の1日以後
  // 18年経過: 17年10か月
  function weightAgeTier(regYm, inspectDate) {
    var reg = toDate(regYm);
    var when = toDate(inspectDate) || new Date();
    if (!reg) return "normal";
    var y18 = addMonths(new Date(reg.getFullYear(), reg.getMonth(), 1), 17 * 12 + 10);
    var y13 = addMonths(new Date(reg.getFullYear(), reg.getMonth(), 1), 12 * 12 + 10);
    if (when >= y18) return "y18";
    if (when >= y13) return "y13";
    return "normal";
  }

  function halfTonUnits(weightKg) {
    var kg = Number(weightKg) || 0;
    if (kg <= 0) return 0;
    return Math.ceil(kg / 500);
  }

  function weightTax(opts) {
    opts = opts || {};
    var result = {
      amount: 0,
      periodMonths: 24,
      tier: "normal",
      tierLabel: "13年未満",
      note: "目安。エコカー減税の個別適用や照会サービスの額を優先してください。",
      ok: true
    };
    var inspect = opts.inspectDate || new Date();
    var tier = opts.isEco ? "ecoHonoku" : weightAgeTier(opts.registeredYm, inspect);
    result.tier = tier;
    result.tierLabel = tier === "y18" ? "18年経過" : tier === "y13" ? "13年経過" : tier === "ecoHonoku" ? "エコカー（本則税率）" : "エコカー以外・13年未満";

    if (opts.isKei) {
      result.amount = KEI_WEIGHT_2Y[tier] || KEI_WEIGHT_2Y.normal;
      return result;
    }
    var units = halfTonUnits(opts.weightKg);
    if (!units) {
      result.ok = false;
      result.note = "車両重量を入力すると計算できます。";
      return result;
    }
    var per = WEIGHT_PER_HALF_TON_2Y[tier] || WEIGHT_PER_HALF_TON_2Y.normal;
    result.amount = per * units;
    return result;
  }

  function jibaiseki(opts) {
    opts = opts || {};
    var months = Number(opts.months) || 24;
    var start = toDate(opts.startDate) || new Date();
    var table = opts.isKei ? JIBAISEKI.kei : JIBAISEKI.passenger;
    var row = table[months];
    var result = {
      amount: 0,
      months: months,
      revised: false,
      note: "目安。離島・沖縄県を除く地域の基準料率です。",
      ok: true
    };
    if (!row || !row.after) {
      result.ok = false;
      result.note = months + "か月の料率は未収録です。24か月または36か月を選んでください。";
      return result;
    }
    var cutoff = toDate(JIBAISEKI.cutoff);
    result.revised = start >= cutoff;
    result.amount = result.revised ? row.after : row.before;
    result.table = result.revised ? "2026年11月1日以後始期" : "2026年10月31日以前始期";
    return result;
  }

  function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  function mdLabel(d) {
    d = toDate(d);
    if (!d) return "";
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  // 新車の初回車検: 初度登録年月の1日 + 3年
  function firstShakenFromRegistration(regYm) {
    var reg = toDate(regYm);
    if (!reg) return null;
    return ymd(addMonths(new Date(reg.getFullYear(), reg.getMonth(), 1), 36));
  }

  // アンカー: 購入後の初回車検日。旧データは nextShakenDate をアンカーとして使う。
  function shakenAnchorDate(veh) {
    if (!veh) return null;
    if (typeof veh === "string") return toDate(veh);
    return toDate(veh.firstShakenDate) || toDate(veh.nextShakenDate) || toDate(firstShakenFromRegistration(veh.registeredYm));
  }

  // 満了日当日まではその回の車検日。翌日以降は2年サイクルで繰り上げ。
  function nextShakenFromAnchor(anchor, asOf) {
    var start = toDate(anchor);
    if (!start) return null;
    var today = toDate(asOf) || new Date();
    var next = start;
    while (next < today) next = addMonths(next, 24);
    return ymd(next);
  }

  function nextShakenDate(veh, asOf) {
    var anchor = shakenAnchorDate(veh);
    if (!anchor) return null;
    return nextShakenFromAnchor(anchor, asOf);
  }

  // 初回車検は登録+3年、以降2年ごと（自家用乗用・軽ともに同じ）
  function estimateNextShaken(regYm, asOf) {
    var first = firstShakenFromRegistration(regYm);
    if (!first) return null;
    return nextShakenFromAnchor(first, asOf);
  }

  // 車検は満了日の1か月前の同日から受けられる（月末は前月の末日にクランプ）
  function shakenWindowOpen(expiry) {
    var d = toDate(expiry);
    if (!d) return null;
    return ymd(addMonths(d, -1));
  }

  function shakenInfoStart(expiry) {
    var open = toDate(shakenWindowOpen(expiry));
    if (!open) return null;
    return ymd(addMonths(open, -1));
  }

  function shakenNoticeStart(expiry) {
    var open = toDate(shakenWindowOpen(expiry));
    if (!open) return null;
    return ymd(addDays(open, -7));
  }

  // 段階: お知らせ(info) → 注意(caution) → 要対応(action) → 超過(overdue)。まだ早いときは ok。
  function shakenAlertForExpiry(expiry, asOf) {
    var end = toDate(expiry);
    if (!end) return null;
    var today = toDate(asOf) || new Date();
    var windowOpen = addMonths(end, -1);
    var noticeStart = addDays(windowOpen, -7);
    var infoStart = addMonths(windowOpen, -1);
    var expiryStr = ymd(end);
    var windowStr = ymd(windowOpen);
    var winMd = mdLabel(windowOpen);
    var endMd = mdLabel(end);
    var remainDays = Math.round((end - today) / 86400000);
    var status, message;
    if (today > end) {
      status = "overdue";
      message = "車検期限が過ぎています・期限 " + endMd;
    } else if (today >= windowOpen) {
      status = "action";
      message = "車検を受けられます・期限 " + endMd;
    } else if (today >= noticeStart) {
      status = "caution";
      message = "あと1週間で受けられます・" + winMd + "〜";
    } else if (today >= infoStart) {
      status = "info";
      message = "あと1か月で受けられます・" + winMd + "〜";
    } else {
      status = "ok";
      message = "";
    }
    return {
      status: status,
      message: message,
      dueDate: expiryStr,
      windowOpen: windowStr,
      infoStart: ymd(infoStart),
      noticeStart: ymd(noticeStart),
      remainDays: remainDays
    };
  }

  function defaultShakenDoneExpiry(expiry) {
    var d = toDate(expiry);
    if (!d) return null;
    return ymd(addMonths(d, 24));
  }

  function shakenWindowIsOpen(expiry, asOf) {
    var end = toDate(expiry);
    if (!end) return false;
    var today = toDate(asOf) || new Date();
    today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var windowOpen = addMonths(end, -1);
    return today.getTime() >= windowOpen.getTime();
  }

  function effectiveShakenDue(veh, asOf) {
    if (!veh) return null;
    var due = toDate(veh.shakenDueDate);
    if (due) return ymd(due);
    return nextShakenDate(veh, asOf);
  }

  function shakenReservedDateOf(veh) {
    var d = veh && toDate(veh.shakenReservedDate);
    return d ? ymd(d) : "";
  }

  function isShakenReserved(veh) {
    if (!veh) return false;
    if (veh.shakenReserved === true || veh.shakenReserved === "1" || veh.shakenReserved === "true") return true;
    return !!shakenReservedDateOf(veh);
  }

  // Idempotent: fill shakenDueDate once, normalize reserve flag/date. Does not overwrite an existing due or reserve date.
  function migrateShakenDue(vehicles, asOf) {
    if (!Array.isArray(vehicles)) return false;
    var changed = false;
    vehicles.forEach(function (v) {
      if (!v || typeof v !== "object") return;
      var date = shakenReservedDateOf(v);
      if (date && v.shakenReservedDate !== date) {
        v.shakenReservedDate = date;
        changed = true;
      }
      var res = isShakenReserved(v);
      if (v.shakenReserved !== res) {
        v.shakenReserved = res;
        changed = true;
      }
      if (v.shakenDueDate) return;
      var computed = nextShakenDate(v, asOf);
      var cached = toDate(v.nextShakenDate) ? ymd(toDate(v.nextShakenDate)) : "";
      if (v.firstShakenDate && cached && computed && cached !== computed) v.shakenDueDate = cached;
      else v.shakenDueDate = computed || cached || "";
      if (v.shakenDueDate) changed = true;
    });
    return changed;
  }

  function shakenAlert(veh, asOf) {
    var expiry = effectiveShakenDue(veh, asOf);
    if (!expiry) return null;
    var alert = shakenAlertForExpiry(expiry, asOf);
    if (!alert) return null;
    var open = shakenWindowIsOpen(expiry, asOf);
    alert.windowOpen = open;
    if (open && isShakenReserved(veh)) {
      alert.status = "reserved";
      alert.reserved = true;
      var resDate = shakenReservedDateOf(veh);
      alert.reservedDate = resDate || "";
      alert.message = resDate
        ? ("予約日 " + mdLabel(resDate) + "（期限 " + mdLabel(expiry) + "）")
        : ("予約済・期限 " + mdLabel(expiry));
    }
    return alert;
  }

  function matchVehicle_(r, vehicleId) {
    if (vehicleId == null) return true;
    return r.vehicle === vehicleId || r.vehicleId === vehicleId;
  }

  function fuelRecordSort_(a, b) {
    var ad = String(a.date || ""), bd = String(b.date || "");
    if (ad !== bd) return ad < bd ? -1 : 1;
    var ao = Number(a.odometer), bo = Number(b.odometer);
    var aok = isFinite(ao), bok = isFinite(bo);
    if (aok && bok && ao !== bo) return ao - bo;
    if (aok !== bok) return aok ? 1 : -1;
    return String(a.id || "").localeCompare(String(b.id || ""));
  }

  // 満タン〜満タンの区間。途中の非満タン給油のリットルも含める。
  function fuelIntervals(records, vehicleId) {
    var all = (records || []).filter(function (r) {
      return r && !r.deleted && r.category === "燃費" && matchVehicle_(r, vehicleId) &&
        r.liters != null && r.liters !== "" && Number(r.liters) > 0;
    }).slice().sort(fuelRecordSort_);
    var fullIdx = [];
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      if (r.isFullTank && r.odometer != null && r.odometer !== "" && isFinite(Number(r.odometer))) {
        fullIdx.push(i);
      }
    }
    var intervals = [];
    for (var i = 1; i < fullIdx.length; i++) {
      var prev = all[fullIdx[i - 1]], cur = all[fullIdx[i]];
      var km = Number(cur.odometer) - Number(prev.odometer);
      var liters = 0, amount = 0, midIds = [];
      for (var j = fullIdx[i - 1] + 1; j <= fullIdx[i]; j++) {
        liters += Number(all[j].liters) || 0;
        amount += Number(all[j].amount) || 0;
        if (j < fullIdx[i]) midIds.push(all[j].id);
      }
      if (!(km > 0) || !(liters > 0)) continue;
      intervals.push({
        fromId: prev.id,
        toId: cur.id,
        fromDate: prev.date,
        toDate: cur.date,
        km: km,
        liters: liters,
        kmPerL: km / liters,
        amount: amount,
        midIds: midIds
      });
    }
    return intervals;
  }

  // 通算（全区間の距離合計 ÷ リットル合計）
  function averageFuelEconomy(records, vehicleId) {
    var iv = fuelIntervals(records, vehicleId);
    var km = 0, liters = 0;
    iv.forEach(function (x) { km += x.km; liters += x.liters; });
    return {
      intervals: iv,
      totalKm: km,
      totalLiters: liters,
      kmPerL: liters > 0 ? km / liters : null
    };
  }

  // 満タン記録ID → その回の区間燃費（前回満タンから）
  function fuelEconomyByRecordId(records, vehicleId) {
    var map = {};
    fuelIntervals(records, vehicleId).forEach(function (iv) { map[iv.toId] = iv; });
    return map;
  }

  // 航続距離ランキング（満タン区間の走行距離の大きい順）。同距離は終点日の新しい順。
  // 1給油ごと: 同一車両の直前の給油記録からのオド差（満タン/非満タンを混ぜない）
  function fuelLegs(records, vehicleId) {
    var all = (records || []).filter(function (r) {
      return r && !r.deleted && r.category === "燃費" && matchVehicle_(r, vehicleId) &&
        r.odometer != null && r.odometer !== "" && isFinite(Number(r.odometer));
    }).slice().sort(fuelRecordSort_);
    var ecoMap = {};
    fuelIntervals(records, vehicleId).forEach(function (iv) {
      if (iv && iv.toId) ecoMap[iv.toId] = iv;
    });
    var legs = [];
    for (var i = 1; i < all.length; i++) {
      var prev = all[i - 1], cur = all[i];
      var km = Number(cur.odometer) - Number(prev.odometer);
      if (!(km > 0)) continue;
      var litersRaw = Number(cur.liters);
      var liters = isFinite(litersRaw) ? litersRaw : null;
      var iv = ecoMap[cur.id];
      var kmPerL = (cur.isFullTank && iv && iv.kmPerL != null && isFinite(iv.kmPerL)) ? iv.kmPerL : null;
      legs.push({
        fromId: prev.id,
        toId: cur.id,
        fromDate: prev.date,
        toDate: cur.date,
        km: km,
        liters: liters,
        kmPerL: kmPerL,
        isFullTank: !!cur.isFullTank
      });
    }
    return legs;
  }

  function rangeRanking(records, vehicleId, limit) {
    limit = limit == null ? 3 : Number(limit);
    if (!isFinite(limit) || limit < 0) limit = 3;
    var iv = fuelLegs(records, vehicleId).slice().sort(function (a, b) {
      var ak = Number(a.km) || 0, bk = Number(b.km) || 0;
      if (ak !== bk) return bk - ak;
      var ad = String(a.toDate || ""), bd = String(b.toDate || "");
      if (ad !== bd) return ad < bd ? 1 : -1;
      var aid = String(a.toId || ""), bid = String(b.toId || "");
      if (aid !== bid) return aid < bid ? 1 : -1;
      return 0;
    });
    return iv.slice(0, limit);
  }

  function formatIntervalEndDate(dateStr, asOf) {
    var d = toDate(dateStr);
    if (!d) return dateStr ? String(dateStr) : "";
    var now = toDate(asOf) || new Date();
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + "/" + d.getDate();
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
  }

  // 区間の終点月ごとに距離・リットルを合算
  function monthlyFuelEconomy(records, vehicleId) {
    var by = {};
    fuelIntervals(records, vehicleId).forEach(function (iv) {
      var m = String(iv.toDate || "").slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(m)) return;
      if (!by[m]) by[m] = { month: m, km: 0, liters: 0, count: 0, kmPerL: null };
      by[m].km += iv.km;
      by[m].liters += iv.liters;
      by[m].count += 1;
    });
    return Object.keys(by).sort().map(function (k) {
      var row = by[k];
      row.kmPerL = row.liters > 0 ? row.km / row.liters : null;
      return row;
    });
  }

  function hasFuelValue_(v) {
    if (v == null || v === "") return false;
    var n = Number(v);
    return isFinite(n) && n > 0;
  }

  // sources の2項目から残りの1項目を算出。amount=円, unitPrice=0.1円/L, liters=0.01L
  function deriveFuel(values, sources) {
    var keys = ["amount", "liters", "unitPrice"];
    var src = (sources || []).filter(function (k) { return keys.indexOf(k) >= 0; });
    var derived = keys.filter(function (k) { return src.indexOf(k) < 0; });
    var out = {
      amount: values && values.amount != null ? values.amount : null,
      liters: values && values.liters != null ? values.liters : null,
      unitPrice: values && values.unitPrice != null ? values.unitPrice : null,
      derived: derived.length === 1 ? derived[0] : null,
      ok: false
    };
    if (!out.derived) return out;
    var a = Number(values && values.amount), l = Number(values && values.liters), u = Number(values && values.unitPrice);
    if (out.derived === "unitPrice" && isFinite(a) && isFinite(l) && l > 0) {
      out.unitPrice = Math.round(a / l * 10) / 10;
      out.ok = true;
    } else if (out.derived === "amount" && isFinite(u) && isFinite(l) && l > 0) {
      out.amount = Math.round(u * l);
      out.ok = true;
    } else if (out.derived === "liters" && isFinite(a) && isFinite(u) && u > 0) {
      out.liters = Math.round(a / u * 100) / 100;
      out.ok = true;
    }
    return out;
  }

  // 最後に入力した欄をソースにし、残りを自動計算する対象にする
  function fuelSourcePlan(typedOrder, field, hasValue) {
    var order = (typedOrder || []).filter(function (f) { return f !== field; }).concat(field ? [field] : []);
    var sources = order.filter(function (f) { return hasValue && hasValue[f]; });
    if (sources.length > 2) sources = sources.slice(-2);
    if (sources.length < 2 && field) {
      var prefer = { amount: ["liters", "unitPrice"], liters: ["amount", "unitPrice"], unitPrice: ["liters", "amount"] };
      (prefer[field] || []).forEach(function (p) {
        if (sources.length < 2 && hasValue && hasValue[p] && sources.indexOf(p) < 0) sources.unshift(p);
      });
    }
    if (sources.length > 2) sources = sources.slice(-2);
    var keys = ["amount", "liters", "unitPrice"];
    var derived = sources.length === 2 ? keys.filter(function (k) { return sources.indexOf(k) < 0; })[0] : null;
    return { typedOrder: order, sources: sources, derived: derived };
  }

  function lastRecordForItem(records, vehicleId, item) {
    var list = (records || []).filter(function (r) {
      if (!r || r.deleted) return false;
      if (vehicleId != null && r.vehicle !== vehicleId && r.vehicleId !== vehicleId) return false;
      if (item && item.id && r.maintenanceItemId && r.maintenanceItemId === item.id) return true;
      if (r.maintenanceItemId && item && item.id && r.maintenanceItemId !== item.id) return false;
      if (item.match && typeof item.match === "function") return item.match(r);
      if (r.category !== item.category) return false;
      if (item.subcategory && r.subcategory !== item.subcategory) return false;
      return true;
    }).slice().sort(function (a, b) {
      var ad = String(a.date || ""), bd = String(b.date || "");
      if (ad !== bd) return ad < bd ? 1 : -1;
      return (Number(b.odometer) || 0) - (Number(a.odometer) || 0);
    });
    return list[0] || null;
  }

  function hasBaselineValue(b) {
    if (!b) return false;
    if (b.date) return true;
    if (b.odometer != null && b.odometer !== "" && isFinite(Number(b.odometer))) return true;
    return false;
  }

  function baselineFromManual(item) {
    if (!item) return null;
    var date = item.lastReplacedDate ? String(item.lastReplacedDate) : "";
    var odoN = item.lastReplacedOdo != null && item.lastReplacedOdo !== "" && isFinite(Number(item.lastReplacedOdo))
      ? Number(item.lastReplacedOdo) : null;
    if (!date && odoN == null) return null;
    return { date: date || null, odometer: odoN, source: "manual" };
  }

  function baselineFromRecord(rec) {
    if (!rec) return null;
    var odoN = rec.odometer != null && rec.odometer !== "" && isFinite(Number(rec.odometer))
      ? Number(rec.odometer) : null;
    if (!rec.date && odoN == null) return null;
    return { date: rec.date || null, odometer: odoN, source: "record", record: rec };
  }

  // true if a is newer than b (later date, or same date with higher odo)
  function isNewerBaseline(a, b) {
    if (!hasBaselineValue(a)) return false;
    if (!hasBaselineValue(b)) return true;
    var ad = String(a.date || ""), bd = String(b.date || "");
    if (ad && bd && ad !== bd) return ad > bd;
    if (ad && !bd) return true;
    if (!ad && bd) return false;
    var aok = a.odometer != null && isFinite(Number(a.odometer));
    var bok = b.odometer != null && isFinite(Number(b.odometer));
    if (aok && bok) return Number(a.odometer) > Number(b.odometer);
    if (aok && !bok) return true;
    return false;
  }

  function lastReplacementBaseline(item, records, vehicleId) {
    var recBase = baselineFromRecord(lastRecordForItem(records, vehicleId, item));
    var manBase = baselineFromManual(item);
    if (isNewerBaseline(recBase, manBase)) return recBase;
    if (hasBaselineValue(manBase)) return manBase;
    return recBase || null;
  }

  var ALERT_STATUS_RANK = { overdue: 0, action: 1, caution: 2, soon: 3, info: 4, ok: 5, unknown: 6 };
  var CAUTION_REMAIN_KM = 500;
  var SOON_REMAIN_DAYS = 30;

  function worseStatus(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    var ra = ALERT_STATUS_RANK[a], rb = ALERT_STATUS_RANK[b];
    if (ra == null) ra = 99;
    if (rb == null) rb = 99;
    return ra <= rb ? a : b;
  }
  function remainAxisStatus(remain, opts) {
    opts = opts || {};
    if (remain == null || remain === "" || !isFinite(Number(remain))) return null;
    var n = Number(remain);
    var overdueAt = opts.overdueAt != null ? opts.overdueAt : 0;
    if (n <= overdueAt) return "overdue";
    var cautionAt = opts.cautionAt;
    if (cautionAt != null && n <= Number(cautionAt)) return opts.cautionStatus || "caution";
    return "ok";
  }
  function formatRemainDays(remainDays) {
    if (remainDays == null || remainDays === "" || !isFinite(Number(remainDays))) return "";
    var n = Math.round(Number(remainDays));
    return n <= 0 ? Math.abs(n) + "日超過" : "あと" + n + "日";
  }
  function formatRemainKm(remainKm) {
    if (remainKm == null || remainKm === "" || !isFinite(Number(remainKm))) return "";
    var n = Math.round(Number(remainKm));
    var num = Math.abs(n).toLocaleString("ja-JP");
    return n <= 0 ? num + " km超過" : "あと" + num + " km";
  }

  function alertStatus(item, last, currentOdo, asOf) {
    var today = toDate(asOf) || new Date();
    var kmInt = Number(item.km) || 0;
    var moInt = Number(item.months) || 0;
    var dueKm = null, dueDate = null, remainKm = null, remainDays = null;
    if (last) {
      if (kmInt > 0 && last.odometer != null && last.odometer !== "") {
        dueKm = Number(last.odometer) + kmInt;
        if (currentOdo != null && currentOdo !== "") remainKm = dueKm - Number(currentOdo);
      }
      if (moInt > 0 && last.date) {
        dueDate = addMonths(toDate(last.date), moInt);
        remainDays = Math.round((dueDate - today) / 86400000);
      }
    }
    var soonKm = item.soonKm != null ? item.soonKm : CAUTION_REMAIN_KM;
    var soonDays = item.soonDays != null ? item.soonDays : SOON_REMAIN_DAYS;
    var kmStatus = remainAxisStatus(remainKm, { overdueAt: 0, cautionAt: soonKm, cautionStatus: "caution" });
    var dayStatus = remainAxisStatus(remainDays, { overdueAt: 0, cautionAt: soonDays, cautionStatus: "soon" });
    var status = !last ? "unknown" : (worseStatus(kmStatus, dayStatus) || "ok");
    var triggeredBy = (remainKm != null && remainDays != null)
      ? (remainKm <= 0 || remainDays <= 0
        ? (remainKm != null && remainKm <= 0 && (remainDays == null || remainDays > 0) ? "km"
          : (remainDays != null && remainDays <= 0 && (remainKm == null || remainKm > 0) ? "months"
            : "both"))
        : (kmStatus && kmStatus !== "ok" && dayStatus && dayStatus !== "ok" ? "both"
          : (kmStatus && kmStatus !== "ok" ? "km" : dayStatus && dayStatus !== "ok" ? "months" : null)))
      : (kmStatus && kmStatus !== "ok" ? "km" : dayStatus && dayStatus !== "ok" ? "months" : null);
    return {
      last: last,
      dueKm: dueKm,
      dueDate: dueDate ? ymd(dueDate) : null,
      remainKm: remainKm,
      remainDays: remainDays,
      kmStatus: kmStatus,
      dayStatus: dayStatus,
      status: status,
      triggeredBy: triggeredBy
    };
  }

  function computeAlerts(items, records, vehicleId, currentOdo, asOf) {
    return (items || []).map(function (item) {
      var last = lastReplacementBaseline(item, records, vehicleId);
      var st = alertStatus(item, last, currentOdo, asOf);
      return Object.assign({ item: item }, st);
    });
  }

  function neutralizeCsvFormula(s) {
    s = s == null ? "" : String(s);
    // Excel/Sheets formula injection: leading = + - @ TAB CR
    if (/^[=+\-@\t\r]/.test(s)) return "'" + s;
    return s;
  }

  function escapeCsvField(v) {
    var s = neutralizeCsvFormula(v == null ? "" : String(v));
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function parseCsv(text) {
    // RFC-ish: preserve CR inside quotes, keep newlines in fields
    var s = String(text || "").replace(/^\uFEFF/, "");
    var rows = [];
    var row = [];
    var field = "";
    var i = 0, inQ = false;
    while (i < s.length) {
      var c = s.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (s.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      if (c === "\r") {
        if (s.charAt(i + 1) === "\n") { row.push(field); rows.push(row); row = []; field = ""; i += 2; continue; }
        field += c; i++; continue; // bare CR kept inside field? or treat as newline. Keep as part of field if not CRLF - actually bare CR often is newline. TPSync had a bug about lost CR. We'll treat standalone CR as newline too but preserve CR+LF as one break, and CR inside quotes already handled.
      }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  var DEFAULT_INTERVALS = [
    { id: "engine_oil", label: "エンジンオイル", category: "オイル", subcategory: "エンジン", km: 5000, months: 6 },
    { id: "oil_filter", label: "オイルフィルター", category: "メンテナンス", subcategory: "オイルフィルター", km: 5000, months: 6 },
    { id: "mission_oil", label: "ミッションオイル", category: "オイル", subcategory: "ミッション", km: 30000, months: 24 },
    { id: "diff_oil", label: "デフオイル", category: "オイル", subcategory: "デフ", km: 30000, months: 24 },
    { id: "spark_plug", label: "プラグ", category: "メンテナンス", subcategory: "プラグ", km: 30000, months: 36 },
    { id: "air_filter", label: "エアフィルター", category: "メンテナンス", subcategory: "エアフィルター", km: 20000, months: 24 },
    { id: "brake_fluid", label: "ブレーキフルード", category: "メンテナンス", subcategory: "ブレーキフルード", km: 20000, months: 24 },
    { id: "coolant", label: "クーラント", category: "メンテナンス", subcategory: "クーラント", km: 40000, months: 36 }
  ];


  var CATEGORY_MERGES = {
    "高速代": { id: "交通費", defaultSub: "高速代" },
    "装備品": { id: "カスタム費用", defaultSub: "装備品" }
  };

  var CATEGORIES = [
    { id: "燃費", label: "給油", subs: ["給油"] },
    { id: "オイル", label: "オイル", subs: ["エンジン", "ミッション", "デフ"] },
    { id: "車検", label: "車検", subs: ["車検"] },
    { id: "税金", label: "税金", subs: ["自動車税", "重量税", "その他"] },
    { id: "保険", label: "保険", subs: ["自賠責", "任意"] },
    { id: "定期点検", label: "定期点検", subs: ["定期点検"] },
    { id: "メンテナンス", label: "メンテナンス", subs: ["プラグ", "エアフィルター", "オイルフィルター", "ブレーキフルード", "クーラント", "その他"] },
    { id: "修理", label: "修理", subs: ["修理"] },
    { id: "タイヤ", label: "タイヤ", subs: ["タイヤ"] },
    { id: "カスタム費用", label: "カスタム・装備品", subs: ["ドラレコ", "ETC車載器", "ナビ・オーディオ", "ホイール", "エアロ", "マフラー", "足回り", "内装", "電装品", "ヘルメット", "グローブ", "シューズ", "その他"] },
    { id: "サーキット", label: "サーキット", subs: ["走行料", "ライセンス", "年会費", "パッド・フルード等消耗品"] },
    { id: "洗車・コーティング・ケミカル", label: "洗車・コーティング・ケミカル", subs: ["洗車", "コーティング", "ケミカル"] },
    { id: "駐車場・車庫代", label: "駐車場・車庫代", subs: ["駐車場", "車庫代"] },
    { id: "交通費", label: "交通費", subs: ["高速代", "有料道路", "フェリー", "カーシェア・レンタカー", "代行運転", "レッカー・ロードサービス", "その他"] },
    { id: "ローン・車両代", label: "ローン・車両代", subs: ["ローン", "車両代"] },
    { id: "罰金・反則金", label: "罰金・反則金", subs: ["反則金", "罰金"] }
  ];

  function categoryLabel(id) {
    if (id == null || id === "") return "";
    var i, c, key = canonicalizeCategory(id);
    for (i = 0; i < CATEGORIES.length; i++) {
      c = CATEGORIES[i];
      if (c.id === key || c.id === id) return c.label || c.id;
    }
    return String(id);
  }
  function canonicalizeCategory(name) {
    var s = String(name == null ? "" : name).trim();
    if (!s) return s;
    if (CATEGORY_MERGES[s]) return CATEGORY_MERGES[s].id;
    var i, c;
    for (i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].id === s) return CATEGORIES[i].id;
    }
    for (i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].label === s) return CATEGORIES[i].id;
    }
    return s;
  }
  function migrateRecordCategory(rec) {
    if (!rec) return rec;
    var raw = String(rec.category == null ? "" : rec.category).trim();
    if (!raw) return rec;
    var merge = CATEGORY_MERGES[raw];
    if (merge) {
      rec.category = merge.id;
      var sub = rec.subcategory == null ? "" : String(rec.subcategory).trim();
      if (!sub) rec.subcategory = merge.defaultSub;
      return rec;
    }
    var id = canonicalizeCategory(raw);
    if (id && id !== raw) rec.category = id;
    return rec;
  }
  function migrateHiddenCategories(arr) {
    if (!Array.isArray(arr)) return [];
    var out = [], seen = {}, i, id;
    for (i = 0; i < arr.length; i++) {
      id = canonicalizeCategory(arr[i]) || arr[i];
      if (!id || seen[id]) continue;
      seen[id] = true;
      out.push(id);
    }
    return out;
  }

  return {
    JIDOSHA_BRACKETS: JIDOSHA_BRACKETS,
    JIBAISEKI: JIBAISEKI,
    DEFAULT_INTERVALS: DEFAULT_INTERVALS,
    CATEGORIES: CATEGORIES,
    CATEGORY_MERGES: CATEGORY_MERGES,
    categoryLabel: categoryLabel,
    canonicalizeCategory: canonicalizeCategory,
    migrateRecordCategory: migrateRecordCategory,
    migrateHiddenCategories: migrateHiddenCategories,
    fyStart: fyStart,
    fyLabel: fyLabel,
    isJidoshaZeiHeavy: isJidoshaZeiHeavy,
    jidoshaZei: jidoshaZei,
    weightAgeTier: weightAgeTier,
    weightTax: weightTax,
    jibaiseki: jibaiseki,
    estimateNextShaken: estimateNextShaken,
    firstShakenFromRegistration: firstShakenFromRegistration,
    shakenAnchorDate: shakenAnchorDate,
    nextShakenFromAnchor: nextShakenFromAnchor,
    nextShakenDate: nextShakenDate,
    effectiveShakenDue: effectiveShakenDue,
    defaultShakenDoneExpiry: defaultShakenDoneExpiry,
    shakenWindowIsOpen: shakenWindowIsOpen,
    isShakenReserved: isShakenReserved,
    shakenReservedDateOf: shakenReservedDateOf,
    migrateShakenDue: migrateShakenDue,
    shakenWindowOpen: shakenWindowOpen,
    shakenInfoStart: shakenInfoStart,
    shakenNoticeStart: shakenNoticeStart,
    shakenAlertForExpiry: shakenAlertForExpiry,
    shakenAlert: shakenAlert,
    addDays: addDays,
    mdLabel: mdLabel,
    fuelIntervals: fuelIntervals,
    averageFuelEconomy: averageFuelEconomy,
    fuelEconomyByRecordId: fuelEconomyByRecordId,
    monthlyFuelEconomy: monthlyFuelEconomy,
    fuelLegs: fuelLegs,
    rangeRanking: rangeRanking,
    formatIntervalEndDate: formatIntervalEndDate,
    neutralizeCsvFormula: neutralizeCsvFormula,
    deriveFuel: deriveFuel,
    fuelSourcePlan: fuelSourcePlan,
    lastRecordForItem: lastRecordForItem,
    lastReplacementBaseline: lastReplacementBaseline,
    isNewerBaseline: isNewerBaseline,
    hasBaselineValue: hasBaselineValue,
    alertStatus: alertStatus,
    computeAlerts: computeAlerts,
    worseStatus: worseStatus,
    remainAxisStatus: remainAxisStatus,
    formatRemainDays: formatRemainDays,
    formatRemainKm: formatRemainKm,
    CAUTION_REMAIN_KM: CAUTION_REMAIN_KM,
    SOON_REMAIN_DAYS: SOON_REMAIN_DAYS,
    escapeCsvField: escapeCsvField,
    parseCsv: parseCsv,
    addMonths: addMonths,
    toDate: toDate,
    ymd: ymd
  };
});
