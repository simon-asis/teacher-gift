(function () {
  'use strict';

  var API_URL = (window.GIFT_API_URL || '').trim();
  var $ = function (id) { return document.getElementById(id); };
  var selectedGiftId = '';
  var selectedOption = '';
  var lastState = null;
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
    lastState = state;
    document.title = state.title;
    $('title').textContent = state.title;
    $('notice').textContent = state.notice || '';
    $('deadline').textContent = state.deadlineText ? '신청 마감: ' + state.deadlineText + '까지' : '';
    show('deadline', !!state.deadlineText);

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
      var limited = g.remaining !== null && g.remaining !== undefined;
      var soldout = limited && g.remaining <= 0;
      if (soldout && selectedGiftId === g.id) { selectedGiftId = ''; selectedOption = ''; }

      var label = el('label', 'gift' + (soldout ? ' soldout' : ''));
      var input = el('input');
      input.type = 'radio'; input.name = 'gift'; input.value = g.id;
      input.disabled = soldout || state.closed;
      input.checked = selectedGiftId === g.id;
      input.addEventListener('change', function () {
        selectedGiftId = g.id; selectedOption = '';
        showError(''); syncSelection();
      });

      var thumb = el('div', 'thumb');
      if (g.image) {
        var img = el('img');
        img.src = g.image; img.alt = ''; img.loading = 'lazy';
        img.onerror = function () { img.remove(); thumb.classList.add('empty'); };
        thumb.appendChild(img);
      } else {
        thumb.classList.add('empty');
      }
      if (limited) {
        thumb.appendChild(el('span', 'stock' + (soldout ? ' none' : ''),
          soldout ? '마감' : '남은 수량 ' + g.remaining));
      }

      var info = el('div', 'info');
      info.appendChild(el('div', 'gift-name', g.name));
      if (g.desc) info.appendChild(el('div', 'gift-desc', g.desc));

      var options = g.options || [];
      if (options.length) {
        var opts = el('div', 'opts');
        options.forEach(function (o) {
          var b = el('button', 'opt', o);
          b.type = 'button';
          b.dataset.gift = g.id; b.dataset.option = o;
          b.addEventListener('click', function () {
            selectedOption = o; showError(''); syncSelection();
          });
          opts.appendChild(b);
        });
        info.appendChild(opts);
      }

      label.appendChild(input); label.appendChild(thumb); label.appendChild(info);
      box.appendChild(label);
    });

    show('closed', state.closed);
    show('bar', !state.closed);
    syncSelection();
  }

  function selectedGift() {
    if (!lastState) return null;
    return lastState.gifts.filter(function (g) { return g.id === selectedGiftId; })[0] || null;
  }

  // 옵션 버튼 표시와 아래쪽 "선택한 선물" 문구를 현재 선택에 맞춘다.
  function syncSelection() {
    Array.prototype.forEach.call(document.querySelectorAll('.opt'), function (b) {
      var on = b.dataset.gift === selectedGiftId && b.dataset.option === selectedOption;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var g = selectedGift();
    $('picked').textContent = g
      ? '선택: ' + g.name + (selectedOption ? ' (' + selectedOption + ')' : '')
      : '선물을 선택해주세요';
  }

  function submit(replace) {
    if (submitting) return;
    var dept = $('dept').value;
    var name = $('name').value.replace(/\s+/g, ' ').trim();
    var gift = selectedGift();

    if (!dept) return showError('부서를 선택해주세요.');
    if (!name) return showError('이름을 입력해주세요.');
    if (!gift) return showError('선물을 선택해주세요.');
    if ((gift.options || []).length && !selectedOption) {
      return showError('"' + gift.name + '"의 옵션(' + gift.options.join(' / ') + ')을 선택해주세요.');
    }
    showError('');

    setBusy(true);
    api.apply({ dept: dept, name: name, giftId: selectedGiftId, option: selectedOption, replace: !!replace })
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
          var msg = dept + ' ' + name + ' 선생님은 이미 "' + res.currentGiftName + '"(으)로 신청하셨습니다.\n지금 선택한 선물로 변경할까요?';
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
      { id: '1', name: '텀블러', desc: '355ml', image: 'images/tumbler-green.jpg', options: [], total: null },
      { id: '2', name: '성경전서', desc: '색상 선택', image: '', options: ['그레이', '베이지', '버터'], total: null },
      { id: '3', name: '장갑', desc: '사이즈 선택 · 선착순 3명', image: 'images/gloves.jpg', options: ['S', 'M', 'L'], total: 3 },
      { id: '4', name: '머그', desc: '품절 예시', image: 'images/mug.jpg', options: [], total: 0 }
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
        notice: '한 해 동안 수고 많으셨습니다. 교사 선물 취합합니다.',
        closed: false,
        departments: ['유아부', '유치부', '유년부', '초등부', '청소년부'],
        gifts: gifts.map(function (g) {
          var used = list.filter(function (a) { return a.giftId === g.id; }).length;
          return Object.assign({}, g, { remaining: g.total === null ? null : Math.max(0, g.total - used) });
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
        var label = gift.name + (p.option ? ' (' + p.option + ')' : '');
        var same = idx >= 0 && list[idx].giftId === p.giftId;
        if (same && list[idx].option === p.option) {
          res = { ok: true, code: 'ALREADY', giftName: label };
        } else if (idx >= 0 && !p.replace) {
          res = { ok: false, code: 'DUPLICATE', currentGiftName: list[idx].label };
        } else if (!same && gift.remaining !== null && gift.remaining <= 0) {
          res = { ok: false, code: 'SOLD_OUT', message: '마감된 선물입니다. 다른 선물을 골라주세요.' };
        } else {
          var rec = { dept: p.dept, name: p.name, giftId: gift.id, option: p.option, label: label };
          res = { ok: true, code: idx >= 0 ? 'CHANGED' : 'APPLIED', giftName: label };
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
    selectedGiftId = ''; selectedOption = '';
    $('name').value = '';
    show('done', false);
    load();
  });
  load();
})();
