// Tiny, safe Markdown renderer. All raw HTML is escaped.
// Supports: headings, paragraphs (line breaks kept), **bold**, *italic*, ~~strike~~,
// `code`, fenced code, links, images, lists (nested), task lists, quotes, tables, rules.
(function () {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => /^(https?:\/\/|\/|#|mailto:|data:image\/)/i.test(u);

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => '\u0000' + (codes.push(c) - 1) + '\u0000');
    s = esc(s)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, a, u) => (safeUrl(u) ? `<img alt="${a}" src="${u}">` : a))
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => (safeUrl(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t))
      .replace(/\*\*(?=\S)(.+?)\*\*|__(?=\S)(.+?)__/g, (m, a, b) => `<strong>${a || b}</strong>`)
      .replace(/\*(?=\S)([^*]+?)\*/g, '<em>$1</em>')
      .replace(/(^|[^\w])_(?=\S)([^_]+?)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)(.+?)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
  }

  const LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const indent = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
  const startsBlock = (L, i) => {
    const l = L[i];
    return /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || LI.test(l) ||
      /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) || (l.includes('|') && i + 1 < L.length && isTableSep(L[i + 1]));
  };

  function render(src) {
    const st = { task: 0 };
    return blocks(String(src).replace(/\r\n?/g, '\n').split('\n'), st);
  }

  function blocks(L, st) {
    const out = [];
    let i = 0, m;
    while (i < L.length) {
      const l = L[i];
      if (!l.trim()) { i++; continue; }
      if (/^\s*```/.test(l)) {
        const buf = [];
        i++;
        while (i < L.length && !/^\s*```/.test(L[i])) buf.push(L[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      } else if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
        i++;
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
        out.push('<hr>');
        i++;
      } else if (/^\s*>/.test(l)) {
        const buf = [];
        while (i < L.length && /^\s*>/.test(L[i])) buf.push(L[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${blocks(buf, st)}</blockquote>`);
      } else if (l.includes('|') && i + 1 < L.length && isTableSep(L[i + 1])) {
        const row = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = row(l);
        const align = row(L[i + 1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left'));
        const cell = (tag, c, j) => `<${tag} style="text-align:${align[j] || 'left'}">${inline(c)}</${tag}>`;
        let h = '<table><thead><tr>' + head.map((c, j) => cell('th', c, j)).join('') + '</tr></thead><tbody>';
        i += 2;
        while (i < L.length && L[i].includes('|') && L[i].trim()) h += '<tr>' + row(L[i++]).map((c, j) => cell('td', c, j)).join('') + '</tr>';
        out.push(h + '</tbody></table>');
      } else if (LI.test(l)) {
        const [html, ni] = list(L, i, st);
        out.push(html);
        i = ni;
      } else {
        const buf = [];
        while (i < L.length && L[i].trim() && (buf.length === 0 || !startsBlock(L, i))) buf.push(L[i++].trim());
        out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
      }
    }
    return out.join('');
  }

  function list(L, i, st) {
    const base = indent(L[i]);
    const ordered = /^\s*\d/.test(L[i]);
    let h = '';
    while (i < L.length) {
      const l = L[i];
      if (!l.trim()) {
        if (i + 1 < L.length && LI.test(L[i + 1]) && indent(L[i + 1]) >= base) { i++; continue; }
        break;
      }
      const m = l.match(LI), d = indent(l);
      if (d < base) break;
      if (m && d <= base + 1) {
        let t = m[3], cls = '';
        const tk = t.match(/^\[( |x|X)\](?:\s+(.*))?$/);
        if (tk) {
          const done = tk[1] !== ' ';
          t = `<input type="checkbox" data-ti="${st.task++}"${done ? ' checked' : ''}><span>${inline(tk[2] || '')}</span>`;
          cls = ` class="task${done ? ' done' : ''}"`;
        } else t = inline(t);
        h += (h ? '</li>' : '') + `<li${cls}>` + t;
        i++;
      } else if (m) {
        const [sub, ni] = list(L, i, st);
        h += sub;
        i = ni;
      } else if (d > base) {
        h += '<br>' + inline(l.trim());
        i++;
      } else break;
    }
    if (h) h += '</li>';
    const tag = ordered ? 'ol' : 'ul';
    return [`<${tag}>${h}</${tag}>`, i];
  }

  // Flip the n-th task checkbox in the source text (same order as render()).
  function toggleTask(src, n) {
    const L = src.split('\n');
    let k = 0, fence = false;
    for (let j = 0; j < L.length; j++) {
      if (/^\s*(?:>\s?)*\s*```/.test(L[j])) { fence = !fence; continue; }
      if (fence) continue;
      const m = L[j].match(/^(\s*(?:>\s?)*\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)\]/);
      if (m && k++ === n) {
        L[j] = m[1] + (m[2] === ' ' ? 'x' : ' ') + ']' + L[j].slice(m[0].length);
        break;
      }
    }
    return L.join('\n');
  }

  window.Markdown = { render, toggleTask };
})();
