'use strict';
(() => {
  const ROLE = document.body.dataset.role === 'display' ? 'display' : 'draw';
  const DRAW = ROLE === 'draw';
  const { W, H } = WB;
  const $ = (s) => document.querySelector(s);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r1 = (v) => Math.round(v * 10) / 10;
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };

  // ---------- look & feel ----------
  const PALETTE = ['ink', '#ff5d5d', '#ff9f43', '#ffd43b', '#40c98b', '#4dabf7', '#b197fc'];
  const SIZES = { pen: [3, 6, 12], hl: [16, 28, 48], eraser: [14, 30, 60], note: [26, 38, 60] };
  const BG = { dark: '#1d2229', light: '#f7f6f2' };
  const INK = { dark: '#f1f3f5', light: '#1f2328' };
  const NAMES = ['Fox', 'Otter', 'Heron', 'Lynx', 'Moose', 'Puffin', 'Badger', 'Raven', 'Seal', 'Hare', 'Owl', 'Wren'];
  const UCOLORS = ['#ff6b6b', '#f59f00', '#37b24d', '#1c7ed6', '#ae3ec9', '#f06595', '#0ca678', '#7950f2'];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  // ---------- state ----------
  let S = WB.emptyState();
  let users = [];
  const cid = uid();
  const me = { name: ls('wb-name') || pick(NAMES), color: ls('wb-color') || pick(UCOLORS) };
  ls('wb-name', me.name); ls('wb-color', me.color);

  let tool = ls('wb-tool') || 'pen';
  let color = ls('wb-col') || 'ink';
  let sizeIdx = +(ls('wb-size') || 1);
  if (!PALETTE.includes(color)) color = 'ink';
  if (!(sizeIdx >= 0 && sizeIdx <= 2)) sizeIdx = 1;

  const page = () => S.pages[S.cur] || S.pages[0];
  const col = (c) => (c === 'ink' ? INK[S.bg] || INK.dark : c);
  const byZ = (a, b) => (a.z || 0) - (b.z || 0);

  // ---------- DOM ----------
  const wrap = $('#wrap'), stage = $('#stage'), itemsEl = $('#items'), overlay = $('#overlay');
  const ink = $('#ink'), fx = $('#fx');
  const ictx = ink.getContext('2d'), fctx = fx.getContext('2d');
  let scale = 1, dpr = 1;

  function layout() {
    dpr = window.devicePixelRatio || 1;
    const main = $('#main');
    if (DRAW) main.style.top = $('#bar').offsetHeight + 'px';
    const r = main.getBoundingClientRect();
    const pad = DRAW ? 14 : 0, hint = DRAW ? 26 : 0;
    scale = Math.max(0.05, Math.min((r.width - pad * 2) / W, (r.height - pad * 2 - hint) / H));
    wrap.style.width = W * scale + 'px';
    wrap.style.height = H * scale + 'px';
    stage.style.transform = `scale(${scale})`;
    document.documentElement.style.setProperty('--inv', 1 / scale);
    for (const c of [ink, fx]) {
      c.width = Math.round(W * scale * dpr);
      c.height = Math.round(H * scale * dpr);
    }
    requestRender();
    drawFx();
  }

  // ---------- networking: SSE down, batched POST up ----------
  let queue = [], qkeys = [], sending = false, flushTimer = 0;

  function send(op) {
    // Ops are serialised now, so later local mutations can't leak into them.
    const key = op.t === 'upd' ? 'upd:' + op.id + ':' + Object.keys(op.patch).join() : op.t === 'cur' ? 'cur' : null;
    const json = JSON.stringify(op);
    if (key && qkeys[qkeys.length - 1] === key) queue[queue.length - 1] = json;
    else { queue.push(json); qkeys.push(key); }
    if (!flushTimer) flushTimer = setTimeout(flush, 16);
  }

  async function flush() {
    flushTimer = 0;
    if (sending || !queue.length) return;
    sending = true;
    const batch = queue, keys = qkeys;
    queue = []; qkeys = [];
    try {
      const r = await fetch('/op', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: `{"cid":${JSON.stringify(cid)},"ops":[${batch.join(',')}]}`,
      });
      if (!r.ok && r.status >= 500) throw new Error(r.status);
    } catch {
      queue = batch.concat(queue); qkeys = keys.concat(qkeys); // retry
      sending = false;
      flushTimer = setTimeout(flush, 1000);
      return;
    }
    sending = false;
    if (queue.length) flush();
  }

  function connect() {
    const q = new URLSearchParams({ cid, role: ROLE, name: me.name, color: me.color });
    const es = new EventSource('/events?' + q);
    es.onopen = () => document.body.classList.remove('offline');
    es.onerror = () => document.body.classList.add('offline');
    es.onmessage = (e) => { for (const m of JSON.parse(e.data)) onMessage(m); };
  }

  function onMessage(m) {
    switch (m.t) {
      case 'init':
        S = m.state;
        users = m.users;
        if (!DRAW && m.urls) $('#addr').textContent = '✎ ' + m.urls.slice(0, 2).map((u) => u.replace('http://', '')).join('  ·  ');
        selId = null;
        requestRender();
        break;
      case 'presence':
        users = m.users;
        if (m.left) { removeCursor(m.left); trails.delete(m.left); }
        requestRender(false, false);
        break;
      case 'cur':
        if (DRAW) moveCursor(m);
        break;
      case 'laser':
        addLaser(m.cid, m.c, m.x, m.y);
        break;
      default:
        if (['go', 'newpage', 'delpage'].includes(m.t)) closeEditor(true);
        WB.apply(S, m);
        requestRender(m.t !== 'upd', true);
    }
  }

  // Apply an op locally and share it.
  function act(op) {
    WB.apply(S, op.t === 'put' ? { ...op, objs: op.objs.map(clone) } : op);
    send(op);
    requestRender(op.t !== 'upd', op.t !== 'app');
  }

  // ---------- undo / redo (your own actions) ----------
  const hist = [], redoStack = [];
  function record(undo, redo) {
    hist.push({ undo, redo });
    if (hist.length > 300) hist.shift();
    redoStack.length = 0;
    requestRender(false, false);
  }
  function undo() { const h = hist.pop(); if (h) { h.undo.forEach(act); redoStack.push(h); } }
  function redo() { const h = redoStack.pop(); if (h) { h.redo.forEach(act); hist.push(h); } }

  // ---------- rendering ----------
  let needInk = false, needItems = false, raf = 0;
  function requestRender(inkToo = true, itemsToo = true) {
    needInk = needInk || inkToo;
    needItems = needItems || itemsToo;
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function frame() {
    raf = 0;
    stage.style.background = BG[S.bg] || BG.dark;
    document.documentElement.dataset.bg = S.bg;
    if (needInk) drawInk();
    if (needItems) syncItems();
    needInk = needItems = false;
    if (DRAW) updateUI();
  }

  function drawInk() {
    ictx.setTransform(1, 0, 0, 1, 0, 0);
    ictx.clearRect(0, 0, ink.width, ink.height);
    ictx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    ictx.lineCap = 'round';
    ictx.lineJoin = 'round';
    for (const o of Object.values(page().objs).filter((o) => o.k === 's').sort(byZ)) drawStroke(o);
    ictx.globalAlpha = 1;
  }

  function drawStroke(o) {
    const p = o.pts;
    if (!p || !p.length) return;
    ictx.globalAlpha = o.tool === 'hl' ? (S.bg === 'dark' ? 0.5 : 0.38) : 1;
    ictx.strokeStyle = ictx.fillStyle = col(o.c);
    ictx.lineWidth = o.w;
    ictx.beginPath();
    if (p.length === 1) {
      ictx.arc(p[0][0], p[0][1], o.w / 2, 0, Math.PI * 2);
      ictx.fill();
      return;
    }
    ictx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length - 1; i++)
      ictx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
    ictx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
    ictx.stroke();
  }

  const els = new Map();
  let handle = null;
  function syncItems() {
    const pg = page();
    const list = Object.values(pg.objs).filter((o) => o.k === 'note' || o.k === 'img').sort(byZ);
    const seen = new Set();
    list.forEach((o, i) => {
      seen.add(o.id);
      let el = els.get(o.id);
      if (!el || el._k !== o.k) {
        el?.remove();
        el = document.createElement('div');
        el._k = o.k;
        el.className = 'item ' + o.k;
        el.dataset.id = o.id;
        if (o.k === 'img') {
          const im = new Image();
          im.draggable = false;
          im.alt = '';
          el.appendChild(im);
        } else {
          const md = document.createElement('div');
          md.className = 'md';
          el.appendChild(md);
        }
        els.set(o.id, el);
      }
      el.style.left = o.x + 'px';
      el.style.top = o.y + 'px';
      el.style.width = o.w + 'px';
      el.style.zIndex = i + 1;
      if (o.k === 'img') {
        el.style.height = o.h + 'px';
        if (el.firstChild.getAttribute('src') !== o.src) el.firstChild.src = o.src;
      } else {
        el.style.color = col(o.c);
        el.style.fontSize = (o.fs || 38) + 'px';
        el.classList.toggle('card', !!o.card);
        if (el._md !== o.md) { el._md = o.md; el.firstChild.innerHTML = Markdown.render(o.md || ''); }
      }
      el.classList.toggle('sel', o.id === selId);
      el.classList.toggle('editing', !!editing && editing.id === o.id);
      if (el.parentNode !== itemsEl) itemsEl.appendChild(el);
    });
    for (const [id, el] of els) if (!seen.has(id)) { el.remove(); els.delete(id); }
    if (selId && !pg.objs[selId]) selId = null;
    if (DRAW) placeSelection();
  }

  // ---------- laser pointer ----------
  const trails = new Map(); // cid -> {c, pts:[{x,y,t}]}
  let fxRaf = 0;
  const LASER_MS = 1100;
  function addLaser(id, c, x, y) {
    let tr = trails.get(id);
    if (!tr) trails.set(id, (tr = { c, pts: [] }));
    tr.c = /^#[0-9a-f]{6}$/i.test(c) ? c : '#ff5d5d';
    tr.pts.push({ x, y, t: performance.now() });
    if (!fxRaf) fxRaf = requestAnimationFrame(drawFx);
  }
  function drawFx() {
    fxRaf = 0;
    const now = performance.now();
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, fx.width, fx.height);
    fctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    fctx.lineCap = 'round';
    let alive = false;
    for (const [id, tr] of trails) {
      tr.pts = tr.pts.filter((q) => now - q.t < LASER_MS);
      if (!tr.pts.length) { trails.delete(id); continue; }
      alive = true;
      const P = tr.pts;
      fctx.strokeStyle = tr.c;
      for (let i = 1; i < P.length; i++) {
        const a = 1 - (now - P[i].t) / LASER_MS;
        fctx.globalAlpha = a * 0.8;
        fctx.lineWidth = 3 + 9 * a;
        fctx.beginPath();
        fctx.moveTo(P[i - 1].x, P[i - 1].y);
        fctx.lineTo(P[i].x, P[i].y);
        fctx.stroke();
      }
      const h = P[P.length - 1], a = 1 - (now - h.t) / LASER_MS;
      fctx.globalAlpha = a;
      fctx.shadowColor = tr.c;
      fctx.shadowBlur = 28;
      fctx.fillStyle = tr.c;
      fctx.beginPath(); fctx.arc(h.x, h.y, 13, 0, Math.PI * 2); fctx.fill();
      fctx.shadowBlur = 0;
      fctx.fillStyle = '#fff';
      fctx.beginPath(); fctx.arc(h.x, h.y, 5, 0, Math.PI * 2); fctx.fill();
    }
    fctx.globalAlpha = 1;
    if (alive) fxRaf = requestAnimationFrame(drawFx);
  }

  // ====================================================================
  // Everything below is only for the drawing page.
  // ====================================================================
  let selId = null, editing = null;
  let placeSelection = () => {}, closeEditor = () => {}, moveCursor = () => {}, removeCursor = () => {}, updateUI = () => {};

  if (DRAW) setupDrawing();
  else setupDisplay();

  function setupDisplay() {
    try { navigator.wakeLock?.request('screen').catch(() => {}); } catch {}
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') try { navigator.wakeLock?.request('screen').catch(() => {}); } catch {}
    });
  }

  function setupDrawing() {
    const pt = (e) => {
      const r = stage.getBoundingClientRect();
      return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
    };

    // ----- toolbar -----
    const colorsEl = $('#colors');
    PALETTE.forEach((c, i) => {
      const b = document.createElement('button');
      b.dataset.color = c;
      b.title = (c === 'ink' ? 'Ink (adapts to board)' : c) + ` (${i + 1})`;
      b.innerHTML = `<span class="sw${c === 'ink' ? ' ink' : ''}"${c === 'ink' ? '' : ` style="background:${c}"`}></span>`;
      b.onclick = () => setColor(c);
      colorsEl.appendChild(b);
    });
    document.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
    document.querySelectorAll('[data-size]').forEach((b) => (b.onclick = () => setSize(+b.dataset.size)));
    $('#undo').onclick = undo;
    $('#redo').onclick = redo;
    $('#clear').onclick = clearPage;
    $('#pgPrev').onclick = () => goPage(S.cur - 1);
    $('#pgNext').onclick = () => goPage(S.cur + 1);
    $('#pgNew').onclick = () => { closeEditor(true); act({ t: 'newpage' }); };
    $('#btnImage').onclick = () => $('#file').click();
    $('#file').onchange = (e) => { addImages([...e.target.files], center()); e.target.value = ''; };

    const menu = $('#menu');
    $('#menuBtn').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest('.menuWrap')) menu.hidden = true; });
    menu.onclick = (e) => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (!a) return;
      menu.hidden = true;
      if (a === 'bg') act({ t: 'bg', bg: S.bg === 'dark' ? 'light' : 'dark' });
      if (a === 'name') rename();
      if (a === 'delpage' && confirm(S.pages.length > 1 ? 'Delete this page for everyone?' : 'This is the only page — clear it?')) {
        closeEditor(false);
        act({ t: 'delpage', n: S.cur });
      }
      if (a === 'tv') window.open('/display', '_blank');
      if (a === 'export') location.href = '/export';
    };

    function setTool(t) {
      closeEditor(true);
      tool = t;
      ls('wb-tool', t);
      document.body.dataset.tool = t;
      if (t !== 'select') select(null);
      brush.style.display = 'none';
      requestRender(false, false);
    }
    function setColor(c) {
      color = c;
      ls('wb-col', c);
      const o = selected();
      if (o && o.k === 'note' && o.c !== c) change(o, { c });
      requestRender(false, false);
    }
    function setSize(i) {
      sizeIdx = clamp(i, 0, 2);
      ls('wb-size', sizeIdx);
      const o = selected();
      if (o && o.k === 'note') change(o, { fs: SIZES.note[sizeIdx] });
      requestRender(false, false);
    }
    function goPage(n) {
      if (n < 0 || n >= S.pages.length) return;
      closeEditor(true);
      act({ t: 'go', n });
    }
    function clearPage() {
      const objs = Object.values(page().objs);
      if (!objs.length || !confirm('Clear this page for everyone? (You can undo.)')) return;
      closeEditor(false);
      act({ t: 'clear', p: S.cur });
      record([{ t: 'put', p: S.cur, objs: objs.map(clone) }], [{ t: 'clear', p: S.cur }]);
    }
    function rename() {
      const n = prompt('Your name (shown to others):', me.name);
      if (!n || !n.trim()) return;
      me.name = n.trim().slice(0, 24);
      ls('wb-name', me.name);
      send({ t: 'hello', name: me.name, color: me.color });
    }

    updateUI = () => {
      document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
      document.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === color));
      document.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('on', +b.dataset.size === sizeIdx));
      $('#sizes').style.color = col(color) === INK.light ? '#e8eaed' : col(color);
      $('#undo').disabled = !hist.length;
      $('#redo').disabled = !redoStack.length;
      $('#pgLabel').textContent = `${S.cur + 1} / ${S.pages.length}`;
      $('#pgPrev').disabled = S.cur <= 0;
      $('#pgNext').disabled = S.cur >= S.pages.length - 1;
      $('[data-act="bg"]').textContent = S.bg === 'dark' ? 'Switch to light board' : 'Switch to dark board';
      const people = users.filter((u) => u.role === 'draw');
      const key = JSON.stringify(people);
      const pe = $('#people');
      if (pe._key !== key) {
        pe._key = key;
        pe.innerHTML = '';
        for (const u of people) {
          const a = document.createElement('div');
          a.className = 'av' + (u.cid === cid ? ' me' : '');
          a.style.background = u.color;
          a.textContent = (u.name || '?').slice(0, 1).toUpperCase();
          a.title = u.cid === cid ? `${u.name} (you) — click to rename` : u.name;
          if (u.cid === cid) a.onclick = rename;
          pe.appendChild(a);
        }
      }
      const tvs = users.filter((u) => u.role === 'display').length;
      $('#tv').classList.toggle('on', tvs > 0);
      $('#tv').title = tvs ? `TV connected${tvs > 1 ? ` (${tvs})` : ''}` : 'No TV connected';
    };

    // ----- overlay helpers -----
    const brush = Object.assign(document.createElement('div'), { className: 'brush' });
    const drop = Object.assign(document.createElement('div'), { className: 'drop' });
    overlay.append(brush, drop);

    const cursors = new Map();
    moveCursor = (m) => {
      if (m.x < 0) return removeCursor(m.cid);
      let c = cursors.get(m.cid);
      if (!c) {
        const el = document.createElement('div');
        el.className = 'rc';
        el.innerHTML = '<svg viewBox="0 0 18 18"><path d="M2 2l13 6-5.5 1.5L7 15z" stroke="#fff" stroke-width="1.2"/></svg><span></span>';
        overlay.appendChild(el);
        cursors.set(m.cid, (c = { el }));
      }
      const u = users.find((u) => u.cid === m.cid);
      const uc = u?.color || '#888';
      c.el.querySelector('path').setAttribute('fill', uc);
      const label = c.el.querySelector('span');
      label.style.background = uc;
      label.textContent = u?.name || '';
      c.el.style.transform = `translate(${m.x * scale}px, ${m.y * scale}px)`;
      c.t = Date.now();
    };
    removeCursor = (id) => { cursors.get(id)?.el.remove(); cursors.delete(id); };
    setInterval(() => { for (const [id, c] of cursors) if (Date.now() - c.t > 5000) removeCursor(id); }, 1000);

    let lastCur = 0, lastPos = null, lastPosT = 0;
    wrap.addEventListener('pointermove', (e) => {
      const p = pt(e);
      lastPos = p; lastPosT = Date.now();
      if (Date.now() - lastCur > 40) { lastCur = Date.now(); send({ t: 'cur', x: r1(p.x), y: r1(p.y) }); }
      if (tool === 'eraser') {
        const d = SIZES.eraser[sizeIdx] * scale;
        Object.assign(brush.style, { display: 'block', width: d + 'px', height: d + 'px',
          transform: `translate(${p.x * scale - d / 2}px, ${p.y * scale - d / 2}px)` });
      }
    });
    wrap.addEventListener('pointerleave', () => { brush.style.display = 'none'; send({ t: 'cur', x: -1, y: -1 }); });

    // ----- drawing on the ink layer -----
    let stroke = null, erase = null, lastLaser = 0;
    ink.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const p = pt(e);
      if (tool === 'text') {
        e.preventDefault();
        const hit = noteAt(p);
        if (hit) openEditor(hit);
        else openEditor(null, p);
        return;
      }
      ink.setPointerCapture(e.pointerId);
      if (tool === 'pen' || tool === 'hl') {
        const o = { id: uid(), k: 's', tool, c: color, w: SIZES[tool][sizeIdx], pts: [[r1(p.x), r1(p.y)]], z: Date.now() };
        act({ t: 'put', p: S.cur, objs: [o] });
        stroke = { id: o.id, pg: S.cur, last: p };
      } else if (tool === 'eraser') {
        erase = { pg: S.cur, objs: [], last: p };
        eraseAt(p);
      } else if (tool === 'laser') laserAt(p, true);
    });
    ink.addEventListener('pointermove', (e) => {
      if (stroke) {
        const add = [];
        for (const ev of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) {
          const q = pt(ev);
          if (Math.hypot(q.x - stroke.last.x, q.y - stroke.last.y) >= 1.5) {
            add.push([r1(q.x), r1(q.y)]);
            stroke.last = q;
          }
        }
        if (add.length) act({ t: 'app', p: stroke.pg, id: stroke.id, pts: add });
      } else if (erase) {
        eraseAt(pt(e));
      } else if (tool === 'laser' && (e.buttons || e.pointerType === 'mouse')) laserAt(pt(e));
    });
    const endInk = () => {
      if (stroke) {
        const o = S.pages[stroke.pg]?.objs[stroke.id];
        if (o) record([{ t: 'del', p: stroke.pg, ids: [o.id] }], [{ t: 'put', p: stroke.pg, objs: [clone(o)] }]);
        stroke = null;
      }
      if (erase) {
        if (erase.objs.length)
          record([{ t: 'put', p: erase.pg, objs: erase.objs }], [{ t: 'del', p: erase.pg, ids: erase.objs.map((o) => o.id) }]);
        erase = null;
      }
    };
    ink.addEventListener('pointerup', endInk);
    ink.addEventListener('pointercancel', endInk);

    function laserAt(p, force) {
      addLaser(cid, me.color, p.x, p.y);
      if (force || Date.now() - lastLaser > 25) { lastLaser = Date.now(); send({ t: 'laser', x: r1(p.x), y: r1(p.y), c: me.color }); }
    }

    function eraseAt(p) {
      const r = SIZES.eraser[sizeIdx] / 2;
      // sample along the path since the last position so fast swipes don't skip strokes
      const steps = Math.max(1, Math.ceil(Math.hypot(p.x - erase.last.x, p.y - erase.last.y) / (r / 2)));
      const pg = S.pages[erase.pg];
      if (!pg) return;
      const ids = [];
      for (const o of Object.values(pg.objs)) {
        if (o.k !== 's') continue;
        for (let i = 1; i <= steps; i++) {
          const x = erase.last.x + ((p.x - erase.last.x) * i) / steps, y = erase.last.y + ((p.y - erase.last.y) * i) / steps;
          if (hitStroke(o, x, y, r)) { ids.push(o.id); erase.objs.push(clone(o)); break; }
        }
      }
      erase.last = p;
      if (ids.length) act({ t: 'del', p: erase.pg, ids });
    }

    function hitStroke(o, x, y, r) {
      const R = r + o.w / 2, R2 = R * R, P = o.pts;
      if (P.length === 1) return (P[0][0] - x) ** 2 + (P[0][1] - y) ** 2 <= R2;
      for (let i = 1; i < P.length; i++) {
        const [ax, ay] = P[i - 1], [bx, by] = P[i];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        const t = L2 ? clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1) : 0;
        if ((ax + t * dx - x) ** 2 + (ay + t * dy - y) ** 2 <= R2) return true;
      }
      return false;
    }

    function noteAt(p) {
      const notes = Object.values(page().objs).filter((o) => o.k === 'note').sort(byZ).reverse();
      return notes.find((o) => {
        const el = els.get(o.id);
        return el && p.x >= o.x && p.x <= o.x + el.offsetWidth && p.y >= o.y && p.y <= o.y + el.offsetHeight;
      });
    }

    // ----- selection, moving, resizing (select tool) -----
    const selected = () => (selId ? page().objs[selId] : null);
    function select(id) {
      if (selId === id) return;
      selId = id;
      requestRender(false, true);
    }
    function change(o, patch) {
      const old = {};
      for (const k of Object.keys(patch)) old[k] = o[k];
      act({ t: 'upd', p: S.cur, id: o.id, patch });
      record([{ t: 'upd', p: S.cur, id: o.id, patch: old }], [{ t: 'upd', p: S.cur, id: o.id, patch }]);
    }
    function deleteIds(ids) {
      const objs = ids.map((id) => page().objs[id]).filter(Boolean).map(clone);
      if (!objs.length) return;
      act({ t: 'del', p: S.cur, ids });
      record([{ t: 'put', p: S.cur, objs }], [{ t: 'del', p: S.cur, ids }]);
    }

    const selbar = document.createElement('div');
    selbar.className = 'selbar';
    selbar.innerHTML = '<button data-s="edit">Edit</button><button data-s="card">Card</button><button data-s="front">To front</button><button data-s="del">Delete</button>';
    selbar.style.display = 'none';
    overlay.appendChild(selbar);
    selbar.addEventListener('pointerdown', (e) => e.stopPropagation());
    selbar.onclick = (e) => {
      const a = e.target.closest('[data-s]')?.dataset.s, o = selected();
      if (!a || !o) return;
      if (a === 'edit') openEditor(o);
      if (a === 'card') change(o, { card: !o.card });
      if (a === 'front') change(o, { z: Date.now() });
      if (a === 'del') { deleteIds([o.id]); select(null); }
    };

    placeSelection = () => {
      const o = selected(), el = o && els.get(o.id);
      if (!el || editing || tool !== 'select') {
        selbar.style.display = 'none';
        handle?.remove();
        return;
      }
      if (!handle) { handle = document.createElement('div'); handle.className = 'handle'; }
      if (handle.parentNode !== el) el.appendChild(handle);
      const isNote = o.k === 'note';
      selbar.querySelector('[data-s="edit"]').style.display = isNote ? '' : 'none';
      const cardBtn = selbar.querySelector('[data-s="card"]');
      cardBtn.style.display = isNote ? '' : 'none';
      cardBtn.classList.toggle('on', !!o.card);
      selbar.style.display = 'flex';
      const h = el.offsetHeight;
      let top = o.y * scale - 44;
      if (top < 4) top = (o.y + h) * scale + 12;
      const left = clamp(o.x * scale, 4, wrap.clientWidth - selbar.offsetWidth - 4);
      selbar.style.transform = `translate(${left}px, ${Math.min(top, wrap.clientHeight - 40)}px)`;
    };

    let drag = null;
    itemsEl.addEventListener('pointerdown', (e) => {
      if (tool !== 'select') return;
      const el = e.target.closest('.item');
      if (!el) { select(null); return; }
      const o = page().objs[el.dataset.id];
      if (!o) return;
      if (e.target.matches('input[data-ti]')) {
        e.preventDefault();
        change(o, { md: Markdown.toggleTask(o.md, +e.target.dataset.ti) });
        return;
      }
      e.preventDefault();
      select(o.id);
      el.setPointerCapture(e.pointerId);
      drag = { id: o.id, el, p0: pt(e), o0: { x: o.x, y: o.y, w: o.w, h: o.h }, resize: e.target === handle, moved: false };
    });
    itemsEl.addEventListener('click', (e) => { if (e.target.matches('input[data-ti]') || e.target.closest('a')) e.preventDefault(); });
    itemsEl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const o = page().objs[drag.id];
      if (!o) { drag = null; return; }
      const p = pt(e), dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      let patch;
      if (drag.resize) {
        const w = Math.round(Math.max(o.k === 'img' ? 40 : 120, drag.o0.w + dx));
        patch = o.k === 'img' ? { w, h: Math.round((w * drag.o0.h) / drag.o0.w) } : { w };
      } else patch = { x: Math.round(drag.o0.x + dx), y: Math.round(drag.o0.y + dy) };
      act({ t: 'upd', p: S.cur, id: o.id, patch });
    });
    const endDrag = () => {
      if (!drag) return;
      const o = page().objs[drag.id];
      if (drag.moved && o) {
        const keys = drag.resize ? (o.k === 'img' ? ['w', 'h'] : ['w']) : ['x', 'y'];
        const before = {}, after = {};
        for (const k of keys) { before[k] = drag.o0[k]; after[k] = o[k]; }
        record([{ t: 'upd', p: S.cur, id: o.id, patch: before }], [{ t: 'upd', p: S.cur, id: o.id, patch: after }]);
      }
      drag = null;
    };
    itemsEl.addEventListener('pointerup', endDrag);
    itemsEl.addEventListener('pointercancel', endDrag);
    itemsEl.addEventListener('dblclick', (e) => {
      const el = e.target.closest('.item.note');
      const o = el && page().objs[el.dataset.id];
      if (o && tool === 'select') openEditor(o);
    });

    // ----- markdown note editor -----
    function openEditor(o, p) {
      closeEditor(true);
      select(null);
      const ta = document.createElement('textarea');
      ta.className = 'editor';
      ta.spellcheck = false;
      ta.value = o ? o.md : '';
      ta.placeholder = 'Type Markdown…\n\n# Heading\n- [ ] a task\n**bold**, *italic*, `code`\n\nCtrl+Enter to place · Esc to cancel';
      const x = o ? o.x : p.x, y = o ? o.y : p.y;
      const elH = o ? els.get(o.id)?.offsetHeight || 0 : 0;
      const w = Math.max(320, (o ? o.w : 640) * scale);
      const h = Math.max(180, elH * scale);
      Object.assign(ta.style, {
        width: w + 'px', height: h + 'px',
        left: clamp(x * scale, 4, wrap.clientWidth - w - 4) + 'px',
        top: clamp(y * scale, 4, Math.max(4, wrap.clientHeight - h - 4)) + 'px',
      });
      overlay.appendChild(ta);
      editing = { id: o?.id, pg: S.cur, x, y, ta };
      ta.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Escape') { ev.preventDefault(); closeEditor(false); }
        else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); closeEditor(true); }
      });
      ta.addEventListener('paste', (ev) => ev.stopPropagation());
      ta.addEventListener('blur', () => closeEditor(true));
      setTimeout(() => ta.focus(), 0);
      requestRender(false, true);
    }

    closeEditor = (commit) => {
      if (!editing) return;
      const { id, pg, x, y, ta } = editing;
      editing = null;
      ta.remove();
      const md = ta.value.replace(/\s+$/, '');
      if (commit) {
        const o = id && S.pages[pg]?.objs[id];
        if (id && o) {
          if (!md.trim()) {
            const old = clone(o);
            act({ t: 'del', p: pg, ids: [id] });
            record([{ t: 'put', p: pg, objs: [old] }], [{ t: 'del', p: pg, ids: [id] }]);
          } else if (md !== o.md) {
            const old = o.md;
            act({ t: 'upd', p: pg, id, patch: { md } });
            record([{ t: 'upd', p: pg, id, patch: { md: old } }], [{ t: 'upd', p: pg, id, patch: { md } }]);
          }
        } else if (!id && md.trim()) addNote(md, x, y, pg);
      }
      requestRender(false, true);
    };

    function noteWidth(md) {
      const fs = SIZES.note[sizeIdx];
      const longest = Math.max(...md.split('\n').map((l) => l.replace(/[#*_`>[\]()-]/g, '').length));
      return Math.round(clamp(longest * fs * 0.55 + fs, 280, 1100));
    }

    function addNote(md, x, y, pg = S.cur) {
      const w = noteWidth(md);
      const o = {
        id: uid(), k: 'note', md, c: color, fs: SIZES.note[sizeIdx], card: false, z: Date.now(),
        x: Math.round(clamp(x, 0, W - w)), y: Math.round(clamp(y, 0, H - 60)), w,
      };
      act({ t: 'put', p: pg, objs: [o] });
      record([{ t: 'del', p: pg, ids: [o.id] }], [{ t: 'put', p: pg, objs: [clone(o)] }]);
      return o;
    }

    // ----- paste & drop: markdown and images -----
    const center = () => ({ x: W / 2, y: H / 2 });
    const pastePos = () => (lastPos && Date.now() - lastPosT < 60000 ? lastPos : center());

    document.addEventListener('paste', (e) => {
      if (editing || e.target.closest?.('input, textarea')) return;
      const dt = e.clipboardData;
      if (!dt) return;
      const files = [...dt.files].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        addImages(files, pastePos());
        return;
      }
      const text = dt.getData('text/plain');
      if (text && text.trim()) {
        e.preventDefault();
        const p = pastePos();
        const o = addNote(text.replace(/\s+$/, ''), p.x, p.y);
        if (tool === 'select') select(o.id);
        toast('Pasted as note — double-click to edit');
      }
    });

    let dragDepth = 0;
    wrap.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; wrap.classList.add('dragging'); });
    wrap.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; wrap.classList.remove('dragging'); } });
    wrap.addEventListener('dragover', (e) => e.preventDefault());
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      wrap.classList.remove('dragging');
      const p = pt(e);
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
      if (files.length) return addImages(files, p);
      const text = e.dataTransfer.getData('text/plain');
      if (text && text.trim()) addNote(text, p.x, p.y);
    });

    async function addImages(files, p) {
      for (const f of files) {
        try {
          await addImage(f, p);
          p = { x: p.x + 40, y: p.y + 40 };
        } catch (err) {
          toast('Image upload failed: ' + err.message);
        }
      }
    }

    async function addImage(file, p) {
      toast('Uploading image…', 20000);
      const pg = S.cur;
      const bmp = await createImageBitmap(file);
      let iw = bmp.width, ih = bmp.height, blob = file;
      const MAX = 2400; // keep the little TV PC happy
      if (file.type !== 'image/gif' && Math.max(iw, ih) > MAX) {
        const k = MAX / Math.max(iw, ih);
        const c = document.createElement('canvas');
        c.width = Math.round(iw * k);
        c.height = Math.round(ih * k);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        blob = await new Promise((res) => c.toBlob(res, file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9));
        iw = c.width; ih = c.height;
      }
      bmp.close?.();
      const r = await fetch('/upload', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/png' }, body: blob });
      if (!r.ok) throw new Error(await r.text());
      const { src } = await r.json();
      const k = Math.min(1, 960 / iw, 640 / ih);
      const w = Math.round(iw * k), h = Math.round(ih * k);
      const o = {
        id: uid(), k: 'img', src, w, h, z: Date.now(),
        x: Math.round(clamp(p.x - w / 2, 0, W - w)), y: Math.round(clamp(p.y - h / 2, 0, H - h)),
      };
      act({ t: 'put', p: pg, objs: [o] });
      record([{ t: 'del', p: pg, ids: [o.id] }], [{ t: 'put', p: pg, objs: [clone(o)] }]);
      toast('Image added');
    }

    // ----- keyboard -----
    const KEYS = { v: 'select', p: 'pen', h: 'hl', e: 'eraser', t: 'text', l: 'laser' };
    window.addEventListener('keydown', (e) => {
      if (editing || e.target.closest?.('input, textarea, [contenteditable]')) return;
      const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); redo(); return; }
      if (mod || e.altKey) return;
      const o = selected();
      if ((k === 'delete' || k === 'backspace') && o) { e.preventDefault(); deleteIds([o.id]); select(null); return; }
      if (k === 'enter' && o?.k === 'note') { e.preventDefault(); openEditor(o); return; }
      if (k === 'escape') { select(null); $('#menu').hidden = true; return; }
      if (KEYS[k]) return setTool(KEYS[k]);
      if (k === 'i') return $('#file').click();
      if (/^[1-7]$/.test(k)) return setColor(PALETTE[+k - 1]);
      if (k === '[') return setSize(sizeIdx - 1);
      if (k === ']') return setSize(sizeIdx + 1);
      if (k === 'pageup') { e.preventDefault(); return goPage(S.cur - 1); }
      if (k === 'pagedown') { e.preventDefault(); return goPage(S.cur + 1); }
    });

    let toastTimer = 0;
    function toast(msg, ms = 2200) {
      const t = $('#toast');
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove('show'), ms);
    }

    setTool(tool);
    new ResizeObserver(layout).observe($('#bar'));
  }

  // ---------- start ----------
  window.addEventListener('resize', layout);
  layout();
  connect();
})();
