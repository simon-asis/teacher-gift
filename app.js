(function () {
  'use strict';

  var API_URL = (window.GIFT_API_URL || '').trim();
  var $ = function (id) { return document.getElementById(id); };
  var selectedGiftId = '';
  var submitting = false;

  // ---------- API ----------
  var api = API_URL ? {
    load: function () {
      return fetch(API_URL, { cache: 'no-store' }).then(toJson);
    },
    // Content-Type을 지정하지 않아야(text/plain) Apps Script에서 CORS 문제 없이 동작한다.
    apply: function (payload) {
      return fetch(API_URL, { method: 'POST', body: JSON.stringify(payload) }).then(toJson);
    }
  } : mockApi();

  function toJson(res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // ---------- 화면 ----------
  function load() {
    show('loading', true); show('load-error', false);
    api.load().then(function (state) {
      show('loading', false);
      render(state);
      show('form', true);
    }).catch(function () {
      show('loading', false);
      show('load-error', true);
    });
  }

  function render(state) {
    document.title = state.title;
    $('title').textContent = state.title;
    $('notice').textContent = state.notice || '';

    var dept = $('dept');
    var current = dept.value;
    while (dept.options.length > 1) dept.remove(1);
    state.departments.forEach(function (d) {
      dept.add(new Option(d, d));
    });
    dept.value = current;

    var box = $('gifts');
    box.textContent = '';
    state.gifts.forEach(function (g) {
      var soldout = g.remaining <= 0;
      if (soldout && selectedGiftId === g.id) selectedGiftId = '';

      var label = el('label', 'gift' + (soldout ? ' soldout' : ''));
      var input = el('input');
      input.type = 'radio'; input.name = 'gift'; input.value = g.id;
      input.disabled = soldout || state.closed;
      input.checked = selectedGiftId === g.id;
      input.addEventListener('change', function () { selectedGiftId = g.id; showError(''); });

      var thumb = el('div', 'thumb');
      if (g.image) {
        var img = el('img');
        img.src = g.image; img.alt = ''; img.loading = 'lazy';
        img.onerror = function () { thumb.textContent = '🎁'; };
        thumb.appendChild(img);
      } else {
        thumb.textContent = '🎁';
      }

      var info = el('div');
      info.appendChild(el('div', 'gift-name', g.name));
      if (g.desc) info.appendChild(el('div', 'gift-desc', g.desc));

      var stock = el('span', 'stock' + (soldout ? ' none' : g.remaining <= 3 ? ' low' : ''),
        soldout ? '마감' : '남은 수량 ' + g.remaining);

      label.appendChild(input); label.appendChild(thumb); label.appendChild(info); label.appendChild(stock);
      box.appendChild(label);
    });

    show('closed', state.closed);
    show('submit', !state.closed);
  }

  function submit(replace) {
    if (submitting) return;
    var dept = $('dept').value;
    var name = $('name').value.replace(/\s+/g, ' ').trim();

    if (!dept) return showError('부서를 선택해주세요.');
    if (!name) return showError('이름을 입력해주세요.');
    if (!selectedGiftId) return showError('선물을 선택해주세요.');
    showError('');

    setBusy(true);
    api.apply({ dept: dept, name: name, giftId: selectedGiftId, replace: !!replace })
      .then(function (res) {
        setBusy(false);
        if (res.state) render(res.state);

        if (res.ok) {
          $('done-title').textContent = res.code === 'CHANGED' ? '선물이 변경되었습니다' : '신청이 완료되었습니다';
          $('done-detail').textContent = dept + ' ' + name + ' 선생님 · ' + res.giftName;
          show('form', false); show('done', true);
          window.scrollTo(0, 0);
          return;
        }
        if (res.code === 'DUPLICATE') {
          var msg = dept + ' ' + name + ' 선생님은 이미 "' + res.currentGiftName + '"(으)로 신청하셨습니다.\n선택한 선물로 변경할까요?';
          if (window.confirm(msg)) submit(true);
          return;
        }
        showError(res.message || '신청에 실패했습니다. 다시 시도해주세요.');
      })
      .catch(function () {
        setBusy(false);
        showError('네트워크 오류입니다. 잠시 후 다시 시도해주세요.');
      });
  }

  function setBusy(b) {
    submitting = b;
    $('submit').disabled = b;
    $('submit').textContent = b ? '신청 중…' : '신청하기';
  }

  function showError(msg) {
    $('form-error').textContent = msg;
    show('form-error', !!msg);
  }

  function show(id, on) { $(id).hidden = !on; }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------- 미리보기용 가짜 API (config.js에 URL이 없을 때) ----------
  function mockApi() {
    var KEY = 'gift-demo-apps';
    var gifts = [
      { id: '1', name: '텀블러', desc: '보온·보냉 스테인리스 텀블러', image: '', total: 5 },
      { id: '2', name: '핸드크림 세트', desc: '겨울철 필수 핸드크림 3종', image: '', total: 5 },
      { id: '3', name: '커피 드립백 세트', desc: '드립백 커피 10개입', image: '', total: 2 },
      { id: '4', name: '무릎담요', desc: '부드러운 극세사 담요', image: '', total: 5 },
      { id: '5', name: '도서상품권', desc: '도서문화상품권 1만원권', image: '', total: 0 }
    ];
    function apps() {
      try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
    }
    function save(list) {
      try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* 무시 */ }
    }
    function state() {
      var list = apps();
      return {
        ok: true,
        title: '교사총회 선물 신청',
        notice: '한 해 동안 수고하신 선생님들께 드리는 선물입니다. 한 가지를 골라주세요.',
        closed: false,
        departments: ['영아부', '유치부', '유년부', '초등부', '중등부', '고등부'],
        gifts: gifts.map(function (g) {
          var used = list.filter(function (a) { return a.giftId === g.id; }).length;
          return Object.assign({}, g, { remaining: Math.max(0, g.total - used) });
        })
      };
    }
    return {
      load: function () { return Promise.resolve(state()); },
      apply: function (p) {
        var list = apps();
        var s = state();
        var gift = s.gifts.filter(function (g) { return g.id === p.giftId; })[0];
        var idx = -1;
        list.forEach(function (a, i) { if (a.dept === p.dept && a.name === p.name) idx = i; });
        var res;
        if (idx >= 0 && list[idx].giftId === p.giftId) {
          res = { ok: true, code: 'ALREADY', giftName: gift.name };
        } else if (idx >= 0 && !p.replace) {
          res = { ok: false, code: 'DUPLICATE', currentGiftName: list[idx].giftName };
        } else if (gift.remaining <= 0) {
          res = { ok: false, code: 'SOLD_OUT', message: '마감된 선물입니다. 다른 선물을 골라주세요.' };
        } else {
          var rec = { dept: p.dept, name: p.name, giftId: gift.id, giftName: gift.name };
          res = { ok: true, code: idx >= 0 ? 'CHANGED' : 'APPLIED', giftName: gift.name };
          if (idx >= 0) list[idx] = rec; else list.push(rec);
          save(list);
        }
        res.state = state();
        return new Promise(function (r) { setTimeout(function () { r(res); }, 300); });
      }
    };
  }

  // ---------- 시작 ----------
  $('demo-badge').hidden = !!API_URL;
  $('form').addEventListener('submit', function (e) { e.preventDefault(); submit(false); });
  $('retry').addEventListener('click', load);
  $('again').addEventListener('click', function () {
    selectedGiftId = '';
    $('name').value = '';
    show('done', false);
    load();
  });
  load();
})();
