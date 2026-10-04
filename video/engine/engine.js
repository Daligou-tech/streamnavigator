// Builds a launch video from window.SPEC and exposes the contract render.js
// needs: window.DURATION and window.seek(t). Every frame is a pure function
// of t. window.SCORE is the soundtrack cue list synth.js turns into audio.
//
// SPEC = { product, url, scenes: [{ type, dur, ...fields }] }
// Scene types: hook, ledger, compare, checks, finding, calls, outro.
(function () {
  const S = window.SPEC;
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const p = (t, a, b) => clamp((t - a) / (b - a));
  const out = (x) => 1 - Math.pow(1 - x, 3);
  const back = (x) => { const c = 1.7; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  const lerp = (a, b, x) => a + (b - a) * x;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const appear = (el, t, at, dy = 30, dur = 0.45) => {
    const k = out(p(t, at, at + dur));
    el.style.opacity = k; el.style.transform = `translateY(${(1 - k) * dy}px)`;
  };
  const pop = (el, t, at, dur = 0.35) => {
    const k = p(t, at, at + dur);
    el.style.opacity = clamp(k * 3); el.style.transform = `scale(${lerp(0.7, 1, back(k))})`;
  };
  // Parse "$14,850" style figures so they can count up; returns null if not a figure.
  const fig = (s) => {
    const m = /^([^0-9]*)([0-9][0-9,]*)(\.[0-9]+)?(.*)$/.exec(s || '');
    if (!m) return null;
    return { pre: m[1], n: parseFloat(m[2].replace(/,/g, '') + (m[3] || '')), dec: m[3] ? m[3].length - 1 : 0, post: m[4] };
  };
  const fmt = (f, k) => f.pre + (f.n * k).toLocaleString('en-US', { minimumFractionDigits: f.dec, maximumFractionDigits: f.dec }) + f.post;

  const SCORE = [];
  const cue = (t, type, note) => SCORE.push(note ? { t, type, note } : { t, type });
  const stage = document.body;
  stage.insertAdjacentHTML('beforeend', '<div class="frame-rule" style="top:60px"></div><div class="frame-rule" style="bottom:60px"></div>');


  function words(text, accent) {
    // accent: substring rendered italic in the signal colour
    let html = esc(text);
    if (accent) html = html.replace(esc(accent), '\u0001' + esc(accent) + '\u0002');
    let inAcc = false;
    return html.split(/(\s+)/).map((w) => {
      if (/^\s+$/.test(w)) return ' ';
      if (w === '|') return '<br>';
      let s = w;
      const open = s.includes('\u0001'), close = s.includes('\u0002');
      s = s.replace('\u0001', '').replace('\u0002', '');
      const acc = inAcc || open; if (open) inAcc = true; if (close) inAcc = false;
      return `<span class="w${acc ? ' acc' : ''}">${s}</span>`;
    }).join('');
  }

  const BUILD = {
    hook(sc, el, a, r) {
      el.innerHTML = (sc.eyebrow ? `<div class="eyebrow">${esc(sc.eyebrow)}</div>` : '') +
        `<h1>${words(sc.text, sc.accent)}</h1>` + (sc.lede ? `<div class="lede">${esc(sc.lede)}</div>` : '');
      if (sc.accentOk) el.querySelectorAll('.acc').forEach((x) => x.classList.add('ok'));
      const ws = [...el.querySelectorAll('.w')];
      const ey = el.querySelector('.eyebrow'), lede = el.querySelector('.lede');
      const st = a + 0.25, gap = Math.min(0.11, 1.1 / ws.length);
      cue(st, 'pop');
      const ledeAt = st + ws.length * gap + 0.5;
      if (lede) cue(ledeAt, 'pop');
      r.update = (t) => {
        if (ey) appear(ey, t, a + 0.05, 16);
        ws.forEach((w, i) => { const k = out(p(t, st + i * gap, st + i * gap + 0.5)); w.style.opacity = k; w.style.transform = `translateY(${(1 - k) * 60}px)`; });
        if (lede) appear(lede, t, ledeAt, 20);
      };
    },

    ledger(sc, el, a, r) {
      el.innerHTML = (sc.eyebrow ? `<div class="eyebrow">${esc(sc.eyebrow)}</div>` : '') +
        `<div class="ledger"><div class="ledger-head"><b>${esc(sc.head[0])}</b><span>${esc(sc.head[1] || '')}</span></div>` +
        sc.rows.map((x) => `<div class="row${x[2] ? ' hit' : ''}"><span class="lbl">${esc(x[0])}</span><span class="amt">${esc(x[1])}</span></div>`).join('') +
        (sc.note ? `<div class="note${sc.noteKind === "ok" ? " ok" : ""}"><b>${esc(sc.noteLabel || "Finding.")}</b> ${esc(sc.note)}</div>` : '') +
        `<div class="ledger-foot">${esc(sc.foot)}</div></div>`;
      const rows = [...el.querySelectorAll('.row')], amts = rows.map((x) => x.querySelector('.amt'));
      const note = el.querySelector('.note'), foot = el.querySelector('.ledger-foot'), ey = el.querySelector('.eyebrow');
      const rowAt = (i) => a + 0.45 + i * 0.4;
      const hitAt = rowAt(rows.length) + 0.15, noteAt = hitAt + 0.5, footAt = (note ? noteAt : hitAt) + 0.6;
      sc.rows.forEach((x, i) => cue(rowAt(i), 'type'));
      cue(hitAt, 'tap'); if (note) cue(noteAt, 'pop'); cue(footAt, 'chime');
      r.update = (t) => {
        if (ey) appear(ey, t, a + 0.05, 16);
        rows.forEach((row, i) => {
          appear(row, t, rowAt(i), 14, 0.35);
          const f = fig(sc.rows[i][1]);
          amts[i].textContent = f && !/→/.test(sc.rows[i][1]) ? fmt(f, out(p(t, rowAt(i), rowAt(i) + 0.6))) : sc.rows[i][1];
          if (sc.rows[i][2]) row.style.background = `rgba(251,238,236,${out(p(t, hitAt, hitAt + 0.3))})`;
        });
        if (note) appear(note, t, noteAt, 10, 0.4);
        pop(foot, t, footAt);
        foot.style.color = sc.footColor === 'ok' ? 'var(--ok)' : 'var(--flag)';
      };
    },

    compare(sc, el, a, r) {
      el.innerHTML = (sc.eyebrow ? `<div class="eyebrow">${esc(sc.eyebrow)}</div>` : '') +
        `<div class="cmp"><div class="cmp-top"><span class="k">${esc(sc.kicker || 'Example finding')}</span><span class="verdict ${sc.kind || 'flag'}">${esc(sc.verdict)}</span></div>` +
        sc.items.map((x) => `<div class="cmp-row"><div class="lbl">${esc(x[0])}</div><div class="val">` +
          (x[2] ? `<span class="from">${esc(x[1])}</span><span class="arr">→</span><span class="to">${esc(x[2])}</span>` : `<span>${esc(x[1])}</span>`) +
          `</div>${x[3] ? `<div class="sub">${esc(x[3])}</div>` : ''}</div>`).join('') + '</div>';
      const rows = [...el.querySelectorAll('.cmp-row')], v = el.querySelector('.verdict'), ey = el.querySelector('.eyebrow');
      const rowAt = (i) => a + 0.5 + i * 0.9;
      sc.items.forEach((x, i) => { cue(rowAt(i), 'pop'); if (x[2]) cue(rowAt(i) + 0.45, 'type'); });
      const vAt = rowAt(sc.items.length) + 0.1; cue(vAt, 'tap');
      r.update = (t) => {
        if (ey) appear(ey, t, a + 0.05, 16);
        rows.forEach((row, i) => {
          appear(row, t, rowAt(i), 16);
          const arr = row.querySelector('.arr'), to = row.querySelector('.to');
          if (to) {
            arr.style.opacity = p(t, rowAt(i) + 0.3, rowAt(i) + 0.5);
            const f = fig(sc.items[i][2]), f0 = fig(sc.items[i][1]);
            const k = out(p(t, rowAt(i) + 0.4, rowAt(i) + 1.0));
            to.style.opacity = p(t, rowAt(i) + 0.4, rowAt(i) + 0.55);
            to.textContent = f && f0 && f.pre === f0.pre ? f.pre + Math.round(lerp(f0.n, f.n, k)).toLocaleString('en-US') + f.post : sc.items[i][2];
          }
        });
        pop(v, t, vAt);
      };
    },

    checks(sc, el, a, r) {
      el.innerHTML = `<div class="checks-wrap"><div class="checks-count"><div class="n">0</div><div class="t">${esc(sc.label)}</div></div>` +
        `<div class="checks-list"><div class="checks-inner">` +
        sc.items.map((x, i) => `<div class="chk"><span class="n">${sc.total && sc.total !== sc.items.length ? '·' : String(i + 1).padStart(2, '0')}</span><span>${esc(x)}</span><span class="tk"></span></div>`).join('') +
        '</div></div></div>';
      const n = el.querySelector('.checks-count .n'), inner = el.querySelector('.checks-inner'), items = [...el.querySelectorAll('.chk')];
      const span = sc.dur - 1.3, step = span / items.length;
      const at = (i) => a + 0.5 + i * step;
      items.forEach((x, i) => cue(at(i), 'type'));
      cue(at(items.length - 1) + 0.25, 'chime');
      const total = sc.total || items.length;
      r.update = (t) => {
        appear(el.querySelector('.checks-count'), t, a + 0.05, 20);
        const done = items.filter((x, i) => t >= at(i)).length;
        n.textContent = Math.round(total * (done / items.length));
        // keep the newest ticked item around the middle of the list
        const rowH = items[0].offsetHeight || 86;
        const progress = clamp((t - a - 0.5) / step, 0, items.length);
        const listH = inner.parentNode.offsetHeight, maxShift = Math.max(0, inner.offsetHeight - listH + 40);
        inner.style.transform = `translateY(${-clamp(progress * rowH - listH * 0.4, 0, maxShift)}px)`;
        items.forEach((it, i) => {
          const k = p(t, at(i), at(i) + 0.2), tk = it.querySelector('.tk');
          tk.textContent = k > 0 ? '✓' : '';
          tk.style.background = k > 0 ? 'var(--ok)' : 'transparent';
          tk.style.borderColor = k > 0 ? 'var(--ok)' : 'var(--rule)';
          tk.style.transform = `scale(${k > 0 ? lerp(0.6, 1, back(k)) : 1})`;
          it.style.opacity = 0.35 + 0.65 * k;
        });
      };
    },

    finding(sc, el, a, r) {
      el.innerHTML = (sc.eyebrow ? `<div class="eyebrow">${esc(sc.eyebrow)}</div>` : '') +
        `<div class="sample"><div class="finding-h"><span>${esc(sc.title)}</span><span class="amt">${esc(sc.amt || '')}</span></div>` +
        `<p>${esc(sc.p)}</p>` + (sc.basis ? `<div class="basis">${esc(sc.basis)}</div>` : '') +
        (sc.cite ? `<div class="cite">${esc(sc.cite)}</div>` : '') +
        (sc.pill ? `<span class="pill ${sc.pill[1]}">${esc(sc.pill[0])}</span>` : '') + '</div>';
      const card = el.querySelector('.sample'), h = el.querySelector('.finding-h'), amt = el.querySelector('.finding-h .amt');
      const parts = [...el.querySelectorAll('.sample p, .basis, .cite')], pill = el.querySelector('.pill'), ey = el.querySelector('.eyebrow');
      cue(a + 0.3, 'pop'); cue(a + 0.8, 'tap');
      if (pill) cue(a + 1.0 + parts.length * 0.45, 'chime');
      r.update = (t) => {
        if (ey) appear(ey, t, a + 0.05, 16);
        appear(card, t, a + 0.2, 30);
        const f = fig(sc.amt);
        if (f) amt.textContent = fmt(f, out(p(t, a + 0.6, a + 1.4)));
        parts.forEach((x, i) => appear(x, t, a + 0.9 + i * 0.45, 10));
        if (pill) pop(pill, t, a + 1.0 + parts.length * 0.45);
      };
    },

    calls(sc, el, a, r) {
      el.innerHTML = (sc.title ? `<div class="calls-title">${esc(sc.title)}</div>` : '') +
        `<div class="calls">` + sc.items.map((x) => `<div class="call ${x[2] || ''}"><div class="k">${esc(x[0])}</div><div class="v">${esc(x[1])}</div></div>`).join('') + '</div>';
      const title = el.querySelector('.calls-title'), cards = [...el.querySelectorAll('.call')];
      const at = (i) => a + 0.6 + i * 0.35;
      const notes = [72, 76, 79, 84, 88];
      cards.forEach((c, i) => cue(at(i), 'pop', notes[i % 5]));
      r.update = (t) => {
        if (title) appear(title, t, a + 0.1, 24);
        cards.forEach((c, i) => pop(c, t, at(i), 0.4));
      };
    },

    outro(sc, el, a, r) {
      el.innerHTML = `<div class="logo"><span class="logo-mark"><svg viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></svg></span>StreamNavigator</div>` +
        (sc.product ? `<div class="product">${esc(sc.product)}</div>` : '') +
        `<div class="tag">${esc(sc.tag)}</div><div class="url">${esc(sc.url)}</div>` + (sc.fine ? `<div class="fine">${esc(sc.fine)}</div>` : '');
      const [logo, ...rest] = el.children;
      cue(a + 0.1, 'chime');
      r.update = (t) => { pop(logo, t, a + 0.1, 0.45); rest.forEach((x, i) => appear(x, t, a + 0.45 + i * 0.25, 20)); };
    },
  };

  let T = 0;
  const scenes = S.scenes.map((sc, i) => {
    const el = document.createElement('section');
    el.className = 'scene sc-' + sc.type;
    stage.appendChild(el);
    const a = T, b = T + sc.dur; T = b;
    const last = i === S.scenes.length - 1;
    const r = { el, a, b, last, update: () => {} };
    if (i > 0) cue(a - 0.2, 'whoosh');
    BUILD[sc.type](sc, el, a, r);
    return r;
  });
  window.DURATION = T;
  window.SCORE = SCORE;

  window.seek = (t) => {
    for (const s of scenes) {
      const v = s.a === 0 ? (s.last ? 1 : 1 - p(t, s.b - 0.3, s.b))
        : Math.min(p(t, s.a, s.a + 0.3), s.last ? 1 : 1 - p(t, s.b - 0.3, s.b));
      const on = t >= s.a - 0.01 && (t < s.b || s.last) && v > 0;
      s.el.style.display = on ? 'flex' : 'none';
      if (!on) continue;
      s.el.style.opacity = v;
      s.el.style.transform = `translateY(${(s.a === 0 ? 0 : (1 - out(p(t, s.a, s.a + 0.5))) * 24) - (s.last ? 0 : p(t, s.b - 0.3, s.b) * 24)}px)`;
      s.update(t);
    }
  };
  window.seek(0);
})();
