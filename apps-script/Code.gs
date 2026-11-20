/**
 * 교사총회 선물 신청 - Google Apps Script 백엔드
 *
 * 구글 시트가 DB 역할을 합니다.
 *  - [선물] 시트 : ID / 이름 / 설명 / 이미지 / 수량(비우면 무제한) / 옵션(쉼표로 구분) / 가격
 *                  가격은 시트에서만 보이고 신청 페이지에는 전달되지 않습니다.
 *  - [부서] 시트 : 부서명
 *  - [설정] 시트 : 제목 / 안내문구 / 마감(Y 로 바꾸면 즉시 종료) / 마감일시(이 시각이 지나면 자동 종료)
 *  - [신청] 시트 : 신청시각 / 부서 / 이름 / 선물ID / 선물명 / 옵션
 *  - [집계] 시트 : 선물·옵션별 신청 수 (자동 계산)
 *
 * 최초 1회 setup() 함수를 실행하면 시트가 자동으로 만들어집니다.
 */

const SHEET_GIFTS = '선물';
const SHEET_DEPTS = '부서';
const SHEET_SETTINGS = '설정';
const SHEET_APPS = '신청';
const SHEET_SUMMARY = '집계';

/** 최초 1회 실행: 시트와 예시 데이터를 만든다. (이미 있는 시트는 건드리지 않음) */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  ensureSheet_(ss, SHEET_GIFTS, [
    ['ID', '이름', '설명', '이미지', '수량', '옵션', '가격'],
    ['1', '텀블러', '보온·보냉 스테인리스 텀블러', '', '', '', 0],
    ['2', '장갑', '사이즈 선택 · 선착순 3명', '', 3, 'S,M,L', 0],
  ]);
  ensureSheet_(ss, SHEET_DEPTS, [
    ['부서명'],
    ['유아부'], ['유치부'], ['유년부'], ['초등부'], ['청소년부'],
  ]);
  ensureSheet_(ss, SHEET_SETTINGS, [
    ['항목', '값'],
    ['제목', '교사총회 선물 신청'],
    ['안내문구', '한 해 동안 수고 많으셨습니다. 교사 선물 취합합니다.'],
    ['마감', 'N'],
    ['마감일시', '2026-11-24 23:59'],
  ]);
  // 예전 버전으로 만든 [설정] 시트에 마감일시 항목이 없으면 추가한다.
  const settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
  const keys = values_(ss, SHEET_SETTINGS, 1).map(function (r) { return String(r[0]).trim(); });
  if (keys.indexOf('마감일시') === -1) {
    settingsSheet.appendRow(['마감일시', '2026-11-24 23:59']);
  }
  ensureSheet_(ss, SHEET_APPS, [
    ['신청시각', '부서', '이름', '선물ID', '선물명', '옵션'],
  ]);
  // 예전 버전으로 만든 [신청] 시트에는 옵션 칸 제목이 없으므로 채워준다.
  const apps = ss.getSheetByName(SHEET_APPS);
  if (!String(apps.getRange(1, 6).getValue()).trim()) {
    apps.getRange(1, 6).setValue('옵션').setFontWeight('bold');
  }
  ensureSheet_(ss, SHEET_SUMMARY, [[
    "=QUERY('신청'!A:F, \"select E, F, count(C) where C is not null group by E, F label E '선물', F '옵션', count(C) '신청수'\", 1)",
  ]]);
}

function ensureSheet_(ss, name, rows) {
  if (ss.getSheetByName(name)) return;
  const sh = ss.insertSheet(name);
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sh.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
  sh.setFrozenRows(1);
}

/** 현재 상태 조회 (선물 목록 + 남은 수량) */
function doGet() {
  return json_(readState_());
}

/** 신청 / 변경 */
function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, code: 'BAD_REQUEST', message: '잘못된 요청입니다.' });
  }

  const dept = clean_(req.dept);
  const name = clean_(req.name);
  const giftId = String(req.giftId || '').trim();
  const option = clean_(req.option);
  const replace = req.replace === true;

  if (!dept || !name || !giftId) {
    return json_({ ok: false, code: 'BAD_REQUEST', message: '부서, 이름, 선물을 모두 입력해주세요.' });
  }
  if (name.length > 20 || dept.length > 20) {
    return json_({ ok: false, code: 'BAD_REQUEST', message: '입력값이 너무 깁니다.' });
  }

  // 동시에 여러 명이 신청해도 수량이 초과되지 않도록 잠금
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, code: 'BUSY', message: '신청이 몰리고 있습니다. 잠시 후 다시 시도해주세요.' });
  }

  try {
    const state = readState_();
    if (state.closed) {
      return json_({ ok: false, code: 'CLOSED', message: '신청이 마감되었습니다.', state: state });
    }
    if (state.departments.indexOf(dept) === -1) {
      return json_({ ok: false, code: 'BAD_REQUEST', message: '부서를 다시 선택해주세요.', state: state });
    }
    const gift = state.gifts.filter(function (g) { return g.id === giftId; })[0];
    if (!gift) {
      return json_({ ok: false, code: 'BAD_REQUEST', message: '선물을 다시 선택해주세요.', state: state });
    }
    if (gift.options.length ? gift.options.indexOf(option) === -1 : option !== '') {
      return json_({ ok: false, code: 'BAD_REQUEST', message: '옵션(색상/사이즈)을 선택해주세요.', state: state });
    }
    const label = gift.name + (option ? ' (' + option + ')' : '');

    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_APPS);
    const rows = sh.getLastRow() > 1
      ? sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues()
      : [];

    // 같은 부서 + 같은 이름이면 같은 사람으로 본다 (공백 무시)
    let existingRow = -1;
    let existing = null;
    for (let i = 0; i < rows.length; i++) {
      if (key_(rows[i][1]) === key_(dept) && key_(rows[i][2]) === key_(name)) {
        existingRow = i + 2;
        existing = { giftId: String(rows[i][3]).trim(), giftName: String(rows[i][4]), option: String(rows[i][5]).trim() };
        break;
      }
    }

    const sameGift = !!existing && existing.giftId === giftId;
    if (sameGift && key_(existing.option) === key_(option)) {
      return json_({ ok: true, code: 'ALREADY', message: '이미 같은 선물로 신청되어 있습니다.', giftName: label, state: state });
    }
    if (existing && !replace) {
      const current = existing.giftName + (existing.option ? ' (' + existing.option + ')' : '');
      return json_({ ok: false, code: 'DUPLICATE', message: '이미 신청하셨습니다.', currentGiftName: current, state: state });
    }
    // 같은 선물 안에서 옵션만 바꾸는 경우는 수량을 새로 차지하지 않는다.
    if (!sameGift && gift.remaining !== null && gift.remaining <= 0) {
      return json_({ ok: false, code: 'SOLD_OUT', message: '죄송합니다. 방금 마감된 선물입니다. 다른 선물을 골라주세요.', state: state });
    }

    const record = [new Date(), safe_(dept), safe_(name), gift.id, gift.name, option];
    if (existing) {
      sh.getRange(existingRow, 1, 1, 6).setValues([record]);
    } else {
      sh.appendRow(record);
    }
    SpreadsheetApp.flush();

    return json_({ ok: true, code: existing ? 'CHANGED' : 'APPLIED', giftName: label, state: readState_() });
  } finally {
    lock.releaseLock();
  }
}

function readState_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const settings = {};
  let deadline = null;
  values_(ss, SHEET_SETTINGS, 2).forEach(function (r) {
    const key = String(r[0]).trim();
    if (key === '마감일시') {
      deadline = parseDeadline_(r[1], ss.getSpreadsheetTimeZone());
    } else {
      settings[key] = String(r[1]).trim();
    }
  });
  const expired = deadline !== null && new Date().getTime() > deadline.getTime();

  const departments = values_(ss, SHEET_DEPTS, 1)
    .map(function (r) { return String(r[0]).trim(); })
    .filter(String);

  const counts = {};
  values_(ss, SHEET_APPS, 5).forEach(function (r) {
    const id = String(r[3]).trim();
    if (id) counts[id] = (counts[id] || 0) + 1;
  });

  // 가격(7번째 칸)은 읽지 않는다 → 신청 페이지로 나가지 않음
  const gifts = values_(ss, SHEET_GIFTS, 6)
    .filter(function (r) { return String(r[0]).trim() && String(r[1]).trim(); })
    .map(function (r) {
      const id = String(r[0]).trim();
      // 수량 칸이 비어 있으면 무제한
      const limited = String(r[4]).trim() !== '';
      const total = limited ? (Number(r[4]) || 0) : null;
      return {
        id: id,
        name: String(r[1]).trim(),
        desc: String(r[2]).trim(),
        image: String(r[3]).trim(),
        options: String(r[5]).split(',').map(function (o) { return o.trim(); }).filter(String),
        total: total,
        remaining: limited ? Math.max(0, total - (counts[id] || 0)) : null,
      };
    });

  return {
    ok: true,
    title: settings['제목'] || '교사총회 선물 신청',
    notice: settings['안내문구'] || '',
    closed: expired || String(settings['마감'] || 'N').toUpperCase() === 'Y',
    deadlineText: deadline ? deadlineText_(deadline) : '',
    departments: departments,
    gifts: gifts,
  };
}

/**
 * 마감일시 칸을 한국 시간 기준 시각으로 바꾼다.
 * "2026-11-24 23:59" 처럼 적는다. 시간을 빼고 날짜만 적으면 그날 밤 23:59 까지.
 */
function parseDeadline_(value, sheetTz) {
  let text;
  if (value instanceof Date) {
    text = Utilities.formatDate(value, sheetTz, 'yyyy-MM-dd HH:mm');
  } else {
    text = String(value == null ? '' : value).trim();
  }
  const m = text.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})(?:\D+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const pad = function (n) { return ('0' + n).slice(-2); };
  const hasTime = m[4] !== undefined && !(m[4] === '00' && m[5] === '00');
  const hh = hasTime ? pad(m[4]) : '23';
  const mm = hasTime ? m[5] : '59';
  const iso = m[1] + '-' + pad(m[2]) + '-' + pad(m[3]) + 'T' + hh + ':' + mm + ':59+09:00';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function deadlineText_(d) {
  const tz = 'Asia/Seoul';
  const day = ['일', '월', '화', '수', '목', '금', '토'][Number(Utilities.formatDate(d, tz, 'u')) % 7];
  return Utilities.formatDate(d, tz, 'M월 d일') + '(' + day + ') ' + Utilities.formatDate(d, tz, 'HH:mm');
}

/** 헤더를 제외한 시트 값 */
function values_(ss, name, cols) {
  const sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, cols).getValues();
}

function clean_(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function key_(v) {
  return String(v == null ? '' : v).replace(/^'/, '').replace(/\s+/g, '').toLowerCase();
}

/** 시트에서 수식으로 해석되지 않도록 방지 */
function safe_(v) {
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
