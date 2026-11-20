/**
 * 교사총회 선물 신청 - Google Apps Script 백엔드
 *
 * 구글 시트가 DB 역할을 합니다.
 *  - [선물] 시트 : ID / 이름 / 설명 / 이미지 / 수량
 *  - [부서] 시트 : 부서명
 *  - [설정] 시트 : 제목 / 안내문구 / 마감(Y,N)
 *  - [신청] 시트 : 신청시각 / 부서 / 이름 / 선물ID / 선물명
 *
 * 최초 1회 setup() 함수를 실행하면 시트가 자동으로 만들어집니다.
 */

const SHEET_GIFTS = '선물';
const SHEET_DEPTS = '부서';
const SHEET_SETTINGS = '설정';
const SHEET_APPS = '신청';

/** 최초 1회 실행: 시트와 예시 데이터를 만든다. (이미 있는 시트는 건드리지 않음) */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  ensureSheet_(ss, SHEET_GIFTS, [
    ['ID', '이름', '설명', '이미지', '수량'],
    ['1', '텀블러', '보온·보냉 스테인리스 텀블러', '', 20],
    ['2', '핸드크림 세트', '겨울철 필수 핸드크림 3종', '', 20],
    ['3', '커피 드립백 세트', '드립백 커피 10개입', '', 20],
    ['4', '무릎담요', '부드러운 극세사 담요', '', 20],
    ['5', '도서상품권', '도서문화상품권 1만원권', '', 20],
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
  ]);
  ensureSheet_(ss, SHEET_APPS, [
    ['신청시각', '부서', '이름', '선물ID', '선물명'],
  ]);
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

    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_APPS);
    const rows = sh.getLastRow() > 1
      ? sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues()
      : [];

    // 같은 부서 + 같은 이름이면 같은 사람으로 본다 (공백 무시)
    let existingRow = -1;
    let existing = null;
    for (let i = 0; i < rows.length; i++) {
      if (key_(rows[i][1]) === key_(dept) && key_(rows[i][2]) === key_(name)) {
        existingRow = i + 2;
        existing = { giftId: String(rows[i][3]), giftName: String(rows[i][4]) };
        break;
      }
    }

    if (existing && existing.giftId === giftId) {
      return json_({ ok: true, code: 'ALREADY', message: '이미 같은 선물로 신청되어 있습니다.', giftName: gift.name, state: state });
    }
    if (existing && !replace) {
      return json_({ ok: false, code: 'DUPLICATE', message: '이미 신청하셨습니다.', currentGiftName: existing.giftName, state: state });
    }
    if (gift.remaining <= 0) {
      return json_({ ok: false, code: 'SOLD_OUT', message: '죄송합니다. 방금 마감된 선물입니다. 다른 선물을 골라주세요.', state: state });
    }

    const record = [new Date(), safe_(dept), safe_(name), gift.id, gift.name];
    if (existing) {
      sh.getRange(existingRow, 1, 1, 5).setValues([record]);
    } else {
      sh.appendRow(record);
    }
    SpreadsheetApp.flush();

    return json_({ ok: true, code: existing ? 'CHANGED' : 'APPLIED', giftName: gift.name, state: readState_() });
  } finally {
    lock.releaseLock();
  }
}

function readState_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const settings = {};
  values_(ss, SHEET_SETTINGS, 2).forEach(function (r) {
    settings[String(r[0]).trim()] = String(r[1]).trim();
  });

  const departments = values_(ss, SHEET_DEPTS, 1)
    .map(function (r) { return String(r[0]).trim(); })
    .filter(String);

  const counts = {};
  values_(ss, SHEET_APPS, 5).forEach(function (r) {
    const id = String(r[3]).trim();
    if (id) counts[id] = (counts[id] || 0) + 1;
  });

  const gifts = values_(ss, SHEET_GIFTS, 5)
    .filter(function (r) { return String(r[0]).trim() && String(r[1]).trim(); })
    .map(function (r) {
      const id = String(r[0]).trim();
      const total = Number(r[4]) || 0;
      return {
        id: id,
        name: String(r[1]).trim(),
        desc: String(r[2]).trim(),
        image: String(r[3]).trim(),
        total: total,
        remaining: Math.max(0, total - (counts[id] || 0)),
      };
    });

  return {
    ok: true,
    title: settings['제목'] || '교사총회 선물 신청',
    notice: settings['안내문구'] || '',
    closed: String(settings['마감'] || 'N').toUpperCase() === 'Y',
    departments: departments,
    gifts: gifts,
  };
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
