// Shared board model — used by both the server (Node) and the browser.
// The board is a list of pages; each page holds objects keyed by id:
//   stroke: {id, k:'s', tool:'pen'|'hl', c, w, pts:[[x,y],...], z}
//   note:   {id, k:'note', x, y, w, md, c, fs, card, z}
//   image:  {id, k:'img', x, y, w, h, src, z}
// Coordinates are in a fixed 1920x1080 "board space" that maps to the TV.
(function () {
  const W = 1920, H = 1080;
  const ID = /^[\w-]{1,40}$/;
  const BLOCKED = new Set(['__proto__', 'constructor', 'prototype', 'id', 'k']);

  function emptyState() {
    return { cur: 0, bg: 'dark', pages: [{ objs: {} }] };
  }

  // Applies one state-changing op. Returns true if it was a known op.
  function apply(S, op) {
    const p = Number.isInteger(op.p) ? op.p : S.cur;
    const pg = S.pages[p];
    switch (op.t) {
      case 'put':
        if (!pg || !Array.isArray(op.objs)) return false;
        for (const o of op.objs) if (o && ID.test(o.id)) pg.objs[o.id] = o;
        return true;
      case 'app': {
        const o = pg && ID.test(op.id) && pg.objs[op.id];
        if (o && Array.isArray(o.pts) && Array.isArray(op.pts)) for (const q of op.pts) o.pts.push(q);
        return true;
      }
      case 'upd': {
        const o = pg && ID.test(op.id) && pg.objs[op.id];
        if (o && op.patch && typeof op.patch === 'object')
          for (const key of Object.keys(op.patch)) if (!BLOCKED.has(key)) o[key] = op.patch[key];
        return true;
      }
      case 'del':
        if (pg && Array.isArray(op.ids)) for (const id of op.ids) if (ID.test(id)) delete pg.objs[id];
        return true;
      case 'clear':
        if (pg) pg.objs = {};
        return true;
      case 'go':
        if (Number.isInteger(op.n) && op.n >= 0 && op.n < S.pages.length) S.cur = op.n;
        return true;
      case 'newpage':
        S.pages.push({ objs: {} });
        S.cur = S.pages.length - 1;
        return true;
      case 'delpage':
        if (!Number.isInteger(op.n) || !S.pages[op.n]) return true;
        if (S.pages.length > 1) {
          S.pages.splice(op.n, 1);
          S.cur = Math.min(S.cur, S.pages.length - 1);
        } else S.pages[0].objs = {};
        return true;
      case 'bg':
        if (op.bg === 'dark' || op.bg === 'light') S.bg = op.bg;
        return true;
    }
    return false;
  }

  const WB = { W, H, apply, emptyState };
  if (typeof module !== 'undefined' && module.exports) module.exports = WB;
  else window.WB = WB;
})();
