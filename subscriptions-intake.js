/* =========================================================================
   subscriptions-intake.js — the /subscriptions line editor and free scorecard.

   The scorecard here is computed by navigator-subscription-engine.js, in the
   browser, from what the customer has typed. That is deliberate and it is the
   whole design:

     - it costs nothing to run, so it can genuinely be free;
     - nothing leaves the page to produce it, which is what makes "no bank
       login, ever" more than a slogan;
     - and it is the SAME engine that produces the paid report, so the number
       on the scorecard and the number in the report cannot disagree.

   The checkout button is gated by the same checkSufficiency() the server runs
   in api/navigator-intake.js. Before this existed a customer could reach a $49
   Stripe checkout having typed a single character. See
   docs/SUBSCRIPTIONS-AUDIT.md.
   ========================================================================= */
(function () {
  'use strict';

  var E = window.SubscriptionEngine;
  var listEl = document.getElementById('sub-list');

  // navigator-shared.js and the engine are both loaded from streamnavigator.ai.
  // If either is missing — the page opened from disk, a preview window, a bad
  // deploy — every line below throws on an undefined symbol and the page just
  // looks broken. Say what is wrong instead.
  if (!E || typeof wireUploadZone !== 'function') {
    if (listEl) {
      listEl.innerHTML = '<li class="sub"><p style="margin:0;font-size:.95rem;line-height:1.5">'
        + '<strong>This form is unavailable on this preview.</strong><br>'
        + 'The page loads its decision engine from streamnavigator.ai. Open it there.</p></li>';
    }
    return;
  }

  var uploader = wireUploadZone(
    document.getElementById('upload-zone'),
    document.getElementById('upload-input'),
    document.getElementById('upload-list')
  );

  /* ------------------------------------------------------------- the model */

  var rows = [];
  var nextId = 1;

  function blank(over) {
    var r = {
      _id: nextId++,
      name: '', price: null, period: 'monthly', renewalDate: '',
      lastUsed: '', wouldMiss: '', usedBy: '',
      status: 'active', promoRate: false, bundledWith: '',
      seasonalNeed: '', seasonalFrom: '', seasonalTo: '',
    };
    if (over) for (var k in over) if (Object.prototype.hasOwnProperty.call(over, k)) r[k] = over[k];
    return r;
  }

  // What the engine and the server are given. Empty strings become the
  // 'unknown' the engine understands, rather than being silently dropped —
  // an unanswered question is a fact about the submission, not an absence.
  function toLine(r) {
    var l = {
      name: String(r.name || '').trim(),
      price: (r.price === null || r.price === '' || isNaN(Number(r.price))) ? null : Number(r.price),
      period: r.period === 'annual' ? 'annual' : 'monthly',
      lastUsed: r.lastUsed || 'unknown',
      wouldMiss: r.wouldMiss || 'unknown',
      usedBy: r.usedBy || 'unknown',
      status: r.status === 'cancelled' ? 'cancelled' : 'active',
      promoRate: !!r.promoRate,
    };
    if (r.renewalDate) l.renewalDate = r.renewalDate;
    if (r.bundledWith && String(r.bundledWith).trim()) l.bundledWith = String(r.bundledWith).trim();
    if (r.seasonalNeed && r.seasonalFrom && r.seasonalTo) {
      l.seasonal = {
        need: String(r.seasonalNeed).trim(),
        fromMonth: Number(r.seasonalFrom),
        toMonth: Number(r.seasonalTo),
      };
    }
    return l;
  }

  function lines() {
    return rows.map(toLine).filter(function (l) { return l.name; });
  }

  /* --------------------------------------------------------------- the DOM */

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  var TAPS = [
    {
      key: 'lastUsed', label: 'When did you last use it?',
      opts: [['this-week', 'This week'], ['this-month', 'This month'], ['2-3-months', '2–3 months'],
        ['6-plus-months', '6+ months'], ['never', 'Never']],
    },
    {
      key: 'wouldMiss', label: 'Would you miss it?',
      opts: [['not-at-all', 'Not at all'], ['a-bit', 'A bit'], ['a-lot', 'A lot']],
    },
    {
      key: 'usedBy', label: 'Who else uses it?',
      opts: [['just-me', 'Just me'], ['someone-else-too', 'Someone else too']],
    },
  ];

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function field(labelText, control) {
    return el('div', {}, [el('label', { text: labelText }), control]);
  }

  function monthSelect(value, onChange) {
    var s = el('select');
    s.appendChild(el('option', { value: '', text: 'Month…' }));
    MONTHS.forEach(function (m, i) {
      var o = el('option', { value: String(i + 1), text: m });
      if (String(value) === String(i + 1)) o.selected = true;
      s.appendChild(o);
    });
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }

  function renderRow(r) {
    var li = el('li', { class: 'sub' });

    // --- name / price / period -------------------------------------------
    var nameIn = el('input', {
      type: 'text', value: r.name,
      placeholder: r.status === 'cancelled' ? 'Something you cancelled' : 'e.g. Hulu',
    });
    nameIn.addEventListener('input', function () { r.name = nameIn.value; refresh(false); });

    var priceIn = el('input', {
      type: 'number', min: '0', step: '0.01',
      value: r.price === null ? '' : String(r.price), placeholder: '0.00',
    });
    priceIn.addEventListener('input', function () {
      r.price = priceIn.value === '' ? null : priceIn.value;
      refresh(false);
    });

    var periodSel = el('select');
    [['monthly', 'per month'], ['annual', 'per year']].forEach(function (o) {
      var op = el('option', { value: o[0], text: o[1] });
      if (r.period === o[0]) op.selected = true;
      periodSel.appendChild(op);
    });
    periodSel.addEventListener('change', function () { r.period = periodSel.value; render(); });

    var rm = el('button', { type: 'button', class: 'sub-rm', title: 'Remove', text: '×' });
    rm.addEventListener('click', function () {
      rows = rows.filter(function (x) { return x !== r; });
      render();
    });

    li.appendChild(el('div', { class: 'sub-top' }, [
      field(r.status === 'cancelled' ? 'Cancelled subscription' : 'Subscription', nameIn),
      field('What it costs', priceIn),
      field('Billed', periodSel),
      rm,
    ]));

    // --- the annual renewal date -----------------------------------------
    //
    // Asked only when it matters, and then it is not optional. On an annual
    // plan the date IS the decision: without it the engine refuses to tell
    // the customer to cancel, because cancelling a prepaid year part-way
    // through refunds nothing.
    if (r.period === 'annual' && r.status !== 'cancelled') {
      var dateIn = el('input', { type: 'date', value: r.renewalDate || '' });
      dateIn.addEventListener('change', function () { r.renewalDate = dateIn.value; refresh(false); });
      var wrap = el('div', { style: 'margin-top:12px;max-width:260px' }, [
        field('When does it renew?', dateIn),
      ]);
      wrap.appendChild(el('p', {
        class: 'hint',
        style: 'margin-top:7px',
        text: 'On an annual plan this is the whole decision — we will not tell you to cancel a '
          + 'year you have already paid for.',
      }));
      li.appendChild(wrap);
    }

    // --- the three taps ---------------------------------------------------
    if (r.status !== 'cancelled') {
      var taps = el('div', { class: 'taps' });
      TAPS.forEach(function (t) {
        var seg = el('div', { class: 'seg compact' + (r[t.key] ? '' : ' unanswered') });
        t.opts.forEach(function (o) {
          var b = el('button', { type: 'button', text: o[1] });
          b.setAttribute('aria-pressed', r[t.key] === o[0] ? 'true' : 'false');
          b.addEventListener('click', function () {
            r[t.key] = r[t.key] === o[0] ? '' : o[0];
            render();
          });
          seg.appendChild(b);
        });
        taps.appendChild(el('div', { class: 'tap-row' }, [el('span', { text: t.label }), seg]));
      });
      li.appendChild(taps);
    } else {
      var back = el('div', { class: 'taps' });
      var seg2 = el('div', { class: 'seg compact' + (r.wouldMiss ? '' : ' unanswered') });
      [['a-lot', 'Yes, a lot'], ['a-bit', 'A bit'], ['not-at-all', 'Not really']].forEach(function (o) {
        var b = el('button', { type: 'button', text: o[1] });
        b.setAttribute('aria-pressed', r.wouldMiss === o[0] ? 'true' : 'false');
        b.addEventListener('click', function () { r.wouldMiss = o[0]; render(); });
        seg2.appendChild(b);
      });
      back.appendChild(el('div', { class: 'tap-row' }, [
        el('span', { text: 'Do you miss having it?' }), seg2,
      ]));
      li.appendChild(back);
    }

    // --- the optional flags ----------------------------------------------
    //
    // Behind a fold because most lines need none of them, and in front of the
    // customer because each one can flip a recommendation from cancel to
    // review — which is to say, each one can stop the report costing them
    // money.
    var adv = el('details', { class: 'adv' });
    adv.appendChild(el('summary', { text: 'Anything else about this one? (promo rate, seasonal, bundled)' }));
    var grid = el('div', { class: 'adv-grid' });

    var promo = el('input', { type: 'checkbox' });
    promo.checked = !!r.promoRate;
    promo.addEventListener('change', function () { r.promoRate = promo.checked; refresh(false); });
    grid.appendChild(el('label', { class: 'chk full' }, [promo, el('span', {
      html: '<strong>I am on a promotional or old rate.</strong> Cancelling usually means coming '
        + 'back at the current price, so the saving may not survive the round trip.',
    })]));

    var bundle = el('input', { type: 'text', value: r.bundledWith || '', placeholder: 'e.g. my phone plan' });
    bundle.addEventListener('input', function () { r.bundledWith = bundle.value; refresh(false); });
    grid.appendChild(el('div', { class: 'full' }, [
      field('Bundled with something else? (optional)', bundle),
    ]));

    var need = el('input', {
      type: 'text', value: r.seasonalNeed || '', placeholder: 'e.g. Premier League, ski season',
    });
    need.addEventListener('input', function () { r.seasonalNeed = need.value; refresh(false); });
    grid.appendChild(el('div', { class: 'full' }, [
      field('I only need this for one thing (optional)', need),
    ]));
    grid.appendChild(field('Needed from', monthSelect(r.seasonalFrom, function (v) {
      r.seasonalFrom = v; refresh(false);
    })));
    grid.appendChild(field('Until', monthSelect(r.seasonalTo, function (v) {
      r.seasonalTo = v; refresh(false);
    })));

    adv.appendChild(grid);
    li.appendChild(adv);
    return li;
  }

  /* ------------------------------------------------------------- scorecard */

  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return '$' + Number(n).toFixed(2).replace(/\.00$/, '');
  }

  function cell(k, v, note, good) {
    return el('div', { class: 'sc-cell' }, [
      el('span', { class: 'k', text: k }),
      el('span', { class: 'v' + (good ? ' good' : ''), text: v }),
      note ? el('span', { class: 'n', text: note }) : null,
    ]);
  }

  function renderScorecard() {
    var body = document.getElementById('sc-body');
    var empty = document.getElementById('sc-empty');
    var ls = lines();

    if (!ls.length) {
      body.style.display = 'none';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';
    body.style.display = '';
    body.innerHTML = '';

    var analysis = E.analyze({ lines: ls });
    var sc = E.buildScorecard(analysis);

    body.appendChild(el('div', { class: 'sc-head' }, [
      el('b', { text: 'Your scorecard' }),
      el('span', {
        text: sc.lineCount + (sc.lineCount === 1 ? ' line' : ' lines')
          + (sc.monthlySpend ? ' · ' + money(sc.monthlySpend) + '/mo' : ''),
      }),
    ]));

    body.appendChild(el('div', { class: 'sc-lede', text: sc.headline }));

    var grid = el('div', { class: 'sc-grid' });
    grid.appendChild(cell('Confirmed savings', money(sc.confirmedAnnual) + '/yr',
      'Money that stops leaving your account.', sc.confirmedAnnual > 0));
    grid.appendChild(cell('Conditional', money(sc.conditionalAnnual) + '/yr',
      'Pauses. Counts the billing cycles skipped, not a year.'));
    grid.appendChild(cell('Your call, not ours', String(sc.reviewLines),
      sc.reviewLines ? 'Shared plans, bundles, or something holding your files.' : 'None.'));
    grid.appendChild(cell('Could not price', String(sc.unpricedLines),
      sc.unpricedLines ? 'Add the amount and we will decide these too.' : 'None.'));
    if (sc.atRiskAnnual > 0) {
      grid.appendChild(cell('Shown, not counted', money(sc.atRiskAnnual) + '/yr',
        'Touches a promo rate or a bundle. Never added to the total above.'));
    }
    if (sc.keepUntilLines > 0) {
      grid.appendChild(cell('Annual plans with a date', String(sc.keepUntilLines),
        'Worth real money — on their renewal date, not today.'));
    }
    if (sc.restartLines > 0) {
      grid.appendChild(cell('Worth restarting', String(sc.restartLines), null, true));
    }
    body.appendChild(grid);

    var notes = [];
    if (sc.overlaps.length) {
      notes.push(sc.overlaps.map(function (o) {
        return o.count + ' ' + o.label + ' services';
      }).join(', ') + ' — you are buying the same thing more than once.');
    }
    notes.push('Worked out in your browser. Nothing here has been sent anywhere.');
    notes.push('The report names which line is which, what to do about each, the dates, and the '
      + 'cancellation links we hold.');
    body.appendChild(el('div', { class: 'sc-foot', text: notes.join(' ') }));
  }

  /* ------------------------------------------------------------- the gate */

  function renderGate() {
    var gate = document.getElementById('gate');
    var btn = document.getElementById('pay-btn');
    var ls = lines();
    var r = E.checkSufficiency({ lines: ls });

    if (r.sufficient) {
      gate.style.display = 'none';
      btn.style.opacity = '';
      btn.setAttribute('aria-disabled', 'false');
      return true;
    }

    gate.style.display = ls.length ? 'block' : 'none';
    gate.innerHTML = '';
    gate.appendChild(el('p', {
      style: 'margin:0',
      html: '<b>Not quite enough to run yet.</b> Your scorecard above is live and free either '
        + 'way — this is what the report needs:',
    }));
    var ul = el('ul');
    r.missing.forEach(function (m) {
      ul.appendChild(el('li', { html: '<strong>' + esc(m.label) + '</strong> — ' + esc(m.why) }));
    });
    gate.appendChild(ul);
    btn.style.opacity = '0.45';
    btn.setAttribute('aria-disabled', 'true');
    return false;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* -------------------------------------------------------------- plumbing */

  var rafPending = false;
  function refresh(full) {
    if (full) { render(); return; }
    if (rafPending) return;
    rafPending = true;
    window.requestAnimationFrame(function () {
      rafPending = false;
      renderScorecard();
      renderGate();
    });
  }

  function render() {
    listEl.innerHTML = '';
    rows.forEach(function (r) { listEl.appendChild(renderRow(r)); });
    renderScorecard();
    renderGate();
  }

  document.getElementById('add-btn').addEventListener('click', function () {
    rows.push(blank());
    render();
    var inputs = listEl.querySelectorAll('input[type=text]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  document.getElementById('add-cancelled-btn').addEventListener('click', function () {
    rows.push(blank({ status: 'cancelled' }));
    render();
    showToast('Added — tell us what it was and whether you miss it.');
  });

  document.getElementById('paste-btn').addEventListener('click', function () {
    var box = document.getElementById('paste-box');
    var parsed = E.parseList(box.value);
    if (!parsed.length) {
      showToast('Nothing to read there — one subscription per line.');
      return;
    }
    parsed.forEach(function (p) {
      rows.push(blank({ name: p.name, price: p.price, period: p.period }));
    });
    box.value = '';
    render();
    showToast(parsed.length + ' added. Now answer the three questions on each.');
  });

  /* ------------------------------------------------------------- checkout */

  document.getElementById('pay-btn').addEventListener('click', async function (e) {
    e.preventDefault();
    var btn = e.currentTarget;
    var errEl = document.getElementById('intake-error');
    errEl.style.display = 'none';

    function fail(msg, focusEl) {
      errEl.textContent = msg;
      errEl.style.display = 'block';
      showToast(msg);
      if (focusEl) focusEl.focus();
    }

    // The price moved to $29 and the Stripe link for it does not exist yet.
    // Sending the customer to the old link would charge them $49 for a page
    // that says $29 — the exact defect scripts/check-prices.js exists to
    // catch. Refuse instead. See the setup comment in subscriptions.html.
    var href = btn.getAttribute('href') || '';
    if (href.indexOf('REPLACE_WITH_') !== -1) {
      fail('Checkout is being updated and this button is switched off rather than charging you '
        + 'the old price. Email hello@streamnavigator.ai and we will send you the link.');
      return;
    }

    if (!renderGate()) {
      fail('A few more answers are needed first — see the list above.');
      document.getElementById('gate').scrollIntoView({ block: 'center' });
      return;
    }

    var emailEl = document.getElementById('intake-email');
    var email = emailEl.value.trim();
    if (!email || email.indexOf('@') === -1) {
      fail('Enter a valid email so we can send your report.', emailEl);
      return;
    }

    var original = btn.textContent;
    btn.textContent = 'Saving your submission…';
    btn.style.pointerEvents = 'none';
    try {
      var submission = await submitNavigatorIntake({
        product: 'subscriptions',
        email: email,
        formData: { lines: lines() },
        files: uploader.getFiles(),
      });
      goToStripe(href, { id: submission.id, token: submission.token, product: 'subscriptions' }, email);
    } catch (err) {
      fail((err && err.message) || 'Something went wrong — please try again.');
      btn.textContent = original;
      btn.style.pointerEvents = 'auto';
    }
  });

  // Two empty lines to start. An empty list with an "add" button reads as a
  // form that has not loaded; two rows read as a form that wants filling in.
  rows.push(blank());
  rows.push(blank());
  render();
}());
