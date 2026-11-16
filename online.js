/* AW Tawla — online private rooms layer.
   Loaded after the main game script. Offline play vs the computer is untouched
   until a room is created or joined. */
(function () {
  'use strict';

  var OL = {
    ws: null, seat: null, code: null, host: false,
    started: false, applying: false, peerOnline: false,
    reconnectTimer: null, wantJoin: null // {mode:'create'} or {mode:'join',code}
  };

  function $(id) { return document.getElementById(id); }
  function setStatus(t) { var e = $('status'); if (e) e.textContent = t; }
  function olStatus(t) { var e = $('ol-status'); if (e) e.textContent = t; }

  function playerId() {
    var q = new URLSearchParams(location.search).get('pid');
    if (q) return q;
    var p = null;
    try { p = localStorage.getItem('awt_pid'); } catch (e) {}
    if (!p) {
      p = 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { localStorage.setItem('awt_pid', p); } catch (e) {}
    }
    return p;
  }

  function roomLink() {
    return location.origin + '/?room=' + OL.code;
  }

  /* ---------- game-state snapshot (rejoin / play-again sync) ---------- */
  function snap() {
    return {
      t: 'sync',
      pts: pts, turn: turn, dice: dice, phase: phase, borne: borne,
      winner: winner, specialWin: specialWin, opening: opening, openingDice: openingDice,
      gulbaraDouble: gulbaraDouble, gulbaraStage: gulbaraStage, gulbaraPlayed: gulbaraPlayed,
      roundScore: roundScore, matchScore: matchScore, roundNumber: roundNumber,
      faces: faces, gameMode: gameMode,
      win: winner !== null ? {
        type: $('win-type').textContent,
        score: $('win-score').textContent,
        msg: $('win-msg').textContent
      } : null
    };
  }

  function sendSync() {
    if (OL.seat === null || !OL.ws || OL.ws.readyState !== 1) return;
    var s = snap();
    OL.ws.send(JSON.stringify({ t: 'relay', data: s }));
  }

  function applySync(s) {
    OL.applying = true;
    gameToken++; var token = gameToken;
    pts = s.pts; turn = s.turn; dice = s.dice; phase = s.phase; borne = s.borne;
    winner = s.winner; specialWin = s.specialWin; opening = s.opening; openingDice = s.openingDice;
    gulbaraDouble = s.gulbaraDouble; gulbaraStage = s.gulbaraStage; gulbaraPlayed = s.gulbaraPlayed;
    roundScore = s.roundScore; matchScore = s.matchScore; roundNumber = s.roundNumber;
    faces = s.faces; gameMode = s.gameMode;
    selected = null; rolling = false;
    $('win-overlay').classList.remove('visible');
    if (s.win) {
      $('win-type').textContent = s.win.type;
      $('win-score').textContent = s.win.score;
      $('win-msg').textContent = s.win.msg;
      $('win-overlay').classList.add('visible');
    }
    document.querySelectorAll('[data-game]').forEach(function (x) { x.classList.toggle('active', x.dataset.game === gameMode); });
    $('game-heading').textContent = '🎲 AW Tawla — ' + (gameMode === '31' ? '31' : gameMode === 'gulbara' ? 'الجلبهار' : 'محبوسة');
    if (!OL.started) { OL.started = true; $('splash').classList.add('hidden'); }
    render();
    OL.applying = false;
    if (winner === null && phase === 'roll') setTimeout(function () { if (token === gameToken) roll(); }, 400);
    if (winner === null) setStatus(turn === OL.seat ? '🎲 دورك' : '⏳ دور صاحبك');
  }

  /* ---------- shared roll finalizer (mirrors the original roll() ending) ---------- */
  function finalizeRoll(a, b, token) {
    if (opening) {
      openingDice = [a, b];
      if (a === b) { phase = 'roll'; render(); setTimeout(function () { if (token === gameToken) roll(); }, 600); return; }
      turn = a > b ? 0 : 1; opening = false; phase = 'roll'; render();
      setTimeout(function () { if (token === gameToken) roll(); }, 500);
      return;
    }
    gulbaraDouble = gameMode === 'gulbara' && a === b ? a : 0;
    gulbaraStage = gulbaraDouble ? a : 0; gulbaraPlayed = 0;
    dice = a === b ? [a, a, a, a] : [a, b];
    phase = 'move'; selected = null;
    if (!possible()) finish();
    render();
    if (OL.seat === null && phase === 'move' && turn === 1) {
      setTimeout(function () { if (token === gameToken) computerMove(); }, 650);
    }
  }

  /* ---------- overrides of the original game functions ---------- */
  var _roll = roll;
  roll = function () {
    if (OL.seat !== null) {
      if (phase !== 'roll' || rolling || winner !== null) return;
      var mine = opening ? OL.seat === 0 : turn === OL.seat;
      if (!mine) return; // wait for the peer's roll message
      sound('dice'); rolling = true; var token = gameToken; var ticks = 0; render();
      var interval = setInterval(function () {
        if (token !== gameToken) { clearInterval(interval); return; }
        faces = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
        render(); ticks++;
        if (ticks >= 12) {
          clearInterval(interval); rolling = false;
          var a = faces[0], b = faces[1];
          if (OL.ws && OL.ws.readyState === 1) OL.ws.send(JSON.stringify({ t: 'relay', data: { t: 'roll', d: [a, b] } }));
          finalizeRoll(a, b, token);
          if (!opening) setStatus(turn === OL.seat ? '🎲 دورك' : '⏳ دور صاحبك');
          sendSync();
        }
      }, 85);
      return;
    }
    _roll();
  };

  var _move = move;
  move = function (from, to) {
    var ok = _move(from, to);
    if (ok && OL.seat !== null && !OL.applying) {
      if (OL.ws && OL.ws.readyState === 1) OL.ws.send(JSON.stringify({ t: 'relay', data: { t: 'move', from: from, to: to } }));
      sendSync();
      if (winner === null) setStatus(turn === OL.seat ? '🎲 دورك' : '⏳ دور صاحبك');
    }
    return ok;
  };

  var _computerMove = computerMove;
  computerMove = function () { if (OL.seat !== null) return; _computerMove(); };

  clickPoint = function (i) {
    soundUnlock(); if (phase !== 'move' || rolling) return;
    var me = OL.seat !== null ? OL.seat : 0;
    if (turn !== me) return;
    if (selected !== null && move(selected, i)) return;
    if (freeTop(i, turn)) { selected = i; render(); }
    else $('status').textContent = 'النقلة دي مش مسموحة — المثلث محبوس أو الزهر مش مناسب.';
  };

  bearClick = function () {
    soundUnlock();
    var me = OL.seat !== null ? OL.seat : 0;
    if (turn !== me || selected === null || !allHome(me)) return;
    if (!move(selected, -1)) $('status').textContent = 'لسه مش مسموح تاكل القشاط ده بالزهر الحالي.';
  };

  var _awardWin = awardWin;
  awardWin = function (p, special) {
    _awardWin(p, special);
    if (OL.seat !== null) {
      $('win-msg').textContent = p === OL.seat ? '🏆 مبروك! إنت كسبت' : 'صاحبك كسب الجولة';
      fixOnlineTexts();
    }
  };

  function fixOnlineTexts() {
    var m = $('match');
    if (m) m.textContent = gameMode === '31'
      ? '🎯 الفورة إلى 31 | الجولة ' + roundNumber + ' | إنت ' + roundScore[OL.seat] + ' — ' + roundScore[1 - OL.seat] + ' صاحبك'
      : 'أونلاين · غرفة ' + OL.code + ' | الماتش: إنت ' + matchScore[OL.seat] + ' — ' + matchScore[1 - OL.seat] + ' صاحبك';
    var sc = $('score');
    if (sc && winner !== null) sc.textContent = winner === OL.seat ? 'إنت كسبت' : 'صاحبك كسب';
    var h = document.querySelector('header>div');
    if (h) h.textContent = OL.seat === 0 ? 'إنت بالأبيض — صاحبك بالأسود 🌐 أونلاين' : 'إنت بالأسود — صاحبك بالأبيض 🌐 أونلاين';
  }

  /* ---------- network ---------- */
  function send(data) {
    if (OL.ws && OL.ws.readyState === 1) OL.ws.send(JSON.stringify({ t: 'relay', data: data }));
  }

  function handleGameMessage(m) {
    if (m.t === 'roll') {
      var a = m.d[0], b = m.d[1];
      rolling = true; var token = gameToken; var ticks = 0;
      var interval = setInterval(function () {
        if (token !== gameToken) { clearInterval(interval); return; }
        faces = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
        render(); ticks++;
        if (ticks >= 8) {
          clearInterval(interval); rolling = false; faces = [a, b]; render();
          finalizeRoll(a, b, token);
          setStatus(turn === OL.seat ? '🎲 دورك' : '⏳ دور صاحبك');
        }
      }, 85);
    } else if (m.t === 'move') {
      OL.applying = true;
      move(m.from, m.to);
      OL.applying = false;
      if (winner === null) setStatus(turn === OL.seat ? '🎲 دورك' : '⏳ دور صاحبك');
    } else if (m.t === 'sync') {
      applySync(m);
    } else if (m.t === 'setup') {
      gameMode = m.gameMode;
      theme = m.theme;
      document.querySelectorAll('[data-game]').forEach(function (x) { x.classList.toggle('active', x.dataset.game === gameMode); });
      document.querySelectorAll('[data-theme]').forEach(function (x) { x.classList.toggle('active', x.dataset.theme === theme); });
      document.body.classList.toggle('royal', theme === 'royal');
      document.body.classList.toggle('cafe', theme === 'cafe');
      $('game-heading').textContent = '🎲 AW Tawla — ' + (gameMode === '31' ? '31' : gameMode === 'gulbara' ? 'الجلبهار' : 'محبوسة');
      OL.started = true;
      $('splash').classList.add('hidden');
      matchScore = [0, 0]; roundScore = [0, 0]; roundNumber = 1;
      init();
      fixOnlineTexts();
    } else if (m.t === 'leave') {
      setStatus('صاحبك ساب اللعبة');
    }
  }

  function handleServerMessage(m) {
    if (m.t === 'created') {
      OL.seat = 0; OL.code = m.code; OL.host = true;
      olStatus('الغرفة جاهزة ✅ كود الغرفة: ' + m.code + ' — ابعت اللينك لصاحبك واستناه');
      var sh = $('ol-share'); if (sh) sh.style.display = 'block';
      var cb = $('ol-copybar'); if (cb) cb.style.display = 'inline-block';
      var sb0 = $('start-game'); if (sb0) sb0.disabled = true;
    } else if (m.t === 'joined') {
      OL.seat = m.seat; OL.code = m.code; OL.host = m.seat === 0;
      olStatus(m.peerOnline ? 'دخلت الغرفة ✅ صاحبك موجود — بتبدأ اللعبة…' : 'دخلت الغرفة ✅ مستني صاحبك يفتح اللينك');
      var cb2 = $('ol-copybar'); if (cb2) cb2.style.display = 'inline-block';
      flipBoard();
      var sb1 = $('start-game'); if (sb1) sb1.disabled = true;
    } else if (m.t === 'peer-online') {
      OL.peerOnline = true;
      if (OL.host) {
        if (!OL.started) {
          send({ t: 'setup', gameMode: gameMode, theme: theme });
          OL.started = true;
          $('splash').classList.add('hidden');
          matchScore = [0, 0]; roundScore = [0, 0]; roundNumber = 1;
          init();
          fixOnlineTexts();
        }
      }
    } else if (m.t === 'peer-offline') {
      OL.peerOnline = false;
      if (OL.started) setStatus('⚠️ صاحبك قطع الاتصال — مستنيه يرجع');
    } else if (m.t === 'request-sync') {
      if (OL.started) sendSync();
    } else if (m.t === 'msg') {
      handleGameMessage(m.data);
    } else if (m.t === 'error') {
      olStatus(m.msg === 'room_full' ? 'الغرفة مليانة — فيه اتنين بيلعبوا فيها دلوقتي' : 'الغرفة دي مش موجودة — اتأكد من الكود أو اللينك');
    }
  }

  function connect() {
    if (OL.ws && (OL.ws.readyState === 0 || OL.ws.readyState === 1)) return;
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    var ws = new WebSocket(proto + '://' + location.host + '/ws');
    OL.ws = ws;
    ws.onopen = function () {
      if (!OL.wantJoin) return;
      if (OL.wantJoin.mode === 'create') ws.send(JSON.stringify({ t: 'create', playerId: playerId() }));
      else ws.send(JSON.stringify({ t: 'join', code: OL.wantJoin.code, playerId: playerId() }));
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleServerMessage(m);
    };
    ws.onclose = function () {
      OL.ws = null; OL.peerOnline = false;
      if (OL.seat !== null) {
        setStatus('⚠️ الاتصال اتقطع — بنحاول نرجع…');
        if (OL.code) OL.wantJoin = { mode: 'join', code: OL.code };
        clearTimeout(OL.reconnectTimer);
        OL.reconnectTimer = setTimeout(connect, 2000);
      }
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  /* ---------- UI ---------- */
  function injectUI() {
    var style = document.createElement('style');
    style.textContent =
      '#ol-box{margin:22px auto 4px;max-width:520px}' +
      '#ol-box .ol-title{font-size:21px;font-weight:bold;margin-bottom:10px}' +
      '#ol-box .ol-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;align-items:center}' +
      '#ol-code{padding:12px;border-radius:10px;border:2px solid #8e6846;background:#2b1a10;color:#ffe1b1;font-size:18px;width:130px;text-align:center;text-transform:uppercase}' +
      '#ol-status{margin-top:10px;font-size:15px;color:#ffd9a0;min-height:22px;line-height:1.7;word-break:break-all}' +
      '#ol-share{display:none;margin-top:8px}';
    document.head.appendChild(style);

    var splash = $('splash');
    var startBtn = $('start-game');
    if (splash && startBtn) {
      var box = document.createElement('div');
      box.id = 'ol-box';
      box.innerHTML =
        '<div class="ol-title">🌐 العب أونلاين مع صاحبك</div>' +
        '<div class="ol-row">' +
        '<button id="ol-create" type="button">إنشاء غرفة</button>' +
        '<input id="ol-code" maxlength="6" placeholder="كود الغرفة">' +
        '<button id="ol-join" type="button">دخول الغرفة</button>' +
        '</div>' +
        '<div id="ol-status"></div>' +
        '<div id="ol-share"><button id="ol-copy" type="button">🔗 نسخ لينك الغرفة</button></div>';
      splash.insertBefore(box, startBtn);

      $('ol-create').onclick = function () {
        soundUnlock();
        OL.wantJoin = { mode: 'create' };
        olStatus('بنجهز الغرفة…');
        connect();
      };
      $('ol-join').onclick = function () {
        soundUnlock();
        var c = ($('ol-code').value || '').toUpperCase().trim();
        if (!c) { olStatus('اكتب كود الغرفة الأول'); return; }
        OL.wantJoin = { mode: 'join', code: c };
        olStatus('بدخول الغرفة…');
        connect();
      };
      $('ol-copy').onclick = function () { copyLink(); };
    }

    var bar = document.querySelector('.bar');
    if (bar) {
      var b = document.createElement('button');
      b.id = 'ol-copybar'; b.type = 'button'; b.style.display = 'none';
      b.textContent = '🔗 لينك الغرفة';
      b.onclick = function () { copyLink(); };
      bar.appendChild(b);
    }

    // keep both sides in step on "play again" / "new game" clicks
    var pa = $('play-again');
    if (pa) pa.addEventListener('click', function () {
      if (OL.seat !== null) setTimeout(sendSync, 80);
    });
    var rs = $('reset');
    if (rs) rs.addEventListener('click', function () {
      if (OL.seat !== null) setTimeout(sendSync, 80);
    });
    var eg = $('end-game');
    if (eg) eg.addEventListener('click', function () {
      if (OL.seat !== null) send({ t: 'leave' });
    });

    // auto-join from a shared link
    var roomParam = new URLSearchParams(location.search).get('room');
    if (roomParam) {
      $('ol-code').value = roomParam.toUpperCase().trim();
      OL.wantJoin = { mode: 'join', code: roomParam.toUpperCase().trim() };
      olStatus('بندخلك الغرفة ' + roomParam.toUpperCase().trim() + '…');
      connect();
    }
  }

  function copyLink() {
    var link = roomLink();
    function done() { olStatus('اللينك اتنسخ ✅ ابعته لصاحبك'); setStatus('اللينك اتنسخ ✅ ابعته لصاحبك'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = link; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { olStatus(link); }
      document.body.removeChild(ta);
    }
  }

  // flip the board for the dark side player
  function flipBoard() {
    if (OL.seat === 1) $('board').style.transform = 'rotate(180deg)';
  }

  // the game's render rewrites the header/match lines; re-apply the online wording after it
  var _render = render;
  render = function () {
    _render();
    if (OL.seat !== null) fixOnlineTexts();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectUI);
  else injectUI();
})();
