/* =========================================================================
   home-savings-intake.js — the form, the free scorecard and the checkout gate
   for /home-savings.

   Every decision here comes from navigator-home-savings-engine.js, which the
   page loads first and which api/navigator-intake.js requires on the server.
   One file, so the check that decides whether a customer may pay and the check
   the server enforces cannot drift.

   Modelled on subscriptions-intake.js, which does the same job for the same
   reason. See docs/HOME-SAVINGS-AUDIT.md.
   ========================================================================= */
(function () {
  'use strict';

  var E = window.HomeSavingsEngine;
  if (!E) return;

  var KINDS = E.BILL_KINDS;
  var rows = [];
  var seq = 0;

  var listEl = document.getElementById('bill-list');
  var uploader = wireUploadZone(
    document.getElementById('upload-zone'),
    document.getElementById('upload-input'),
    document.getElementById('upload-list')
  );

  function blank(init) {
    seq += 1;
    return Object.assign({
      uid: 'b' + seq,
      kind: 'internet',
      provider: '',
      monthly: '',
      lastYearMonthly: '',
      equipmentRental: null,
      equipmentFee: '',
      promoRate: null,
      promoEndsOn: '',
      standardRate: '',
      deviceInstalment: null,
      devicePaidOff: null,
      deviceFee: '',
      duplicateCoverage: null,
      duplicateFee: '',
      reliesOnCoverage: null,
      autopayDiscount: null,
      addOnsAnswered: null,
      addOnLabel: '',
      addOnMonthly: '',
    }, init || {});
  }

  function n(v) {
    var x = Number(v);
    return isFinite(x) && x > 0 ? x : null;
  }

  // The shape the engine reads. Built fresh on every render so the scorecard
  // can never disagree with what is on screen.
  function bills() {
    return rows.map(function (r) {
      var addOns = [];
      if (String(r.addOnLabel || '').trim()) {
        addOns.push({ label: String(r.addOnLabel).trim(), monthly: n(r.addOnMonthly) });
      }
      return {
        kind: r.kind,
        provider: String(r.provider || '').trim(),
        monthly: n(r.monthly),
        lastYearMonthly: n(r.lastYearMonthly),
        equipmentRental: r.equipmentRental,
        equipmentFee: n(r.equipmentFee),
        promoRate: r.promoRate,
        promoEndsOn: r.promoEndsOn || null,
        standardRate: n(r.standardRate),
        deviceInstalment: r.deviceInstalment,
        devicePaidOff: r.devicePaidOff,
        deviceFee: n(r.deviceFee),
        duplicateCoverage: r.duplicateCoverage,
        duplicateFee: n(r.duplicateFee),
        reliesOnCoverage: r.reliesOnCoverage,
        // An empty array means "I looked and there are none", which is an
        // answer and makes check H4 count as run. `null` means "not asked"
        // and puts H4 in couldNotRun. The distinction is the whole difference
        // between a clean bill of health and thin coverage.
        addOns: r.addOnsAnswered === true ? addOns
          : r.addOnsAnswered === false ? []
            : null,
        autopayDiscount: r.autopayDiscount,
      };
    });
  }

  /* ------------------------------------------------------------- rendering */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function tri(r, field, labels) {
    var opts = [
      { v: true, t: (labels && labels[0]) || 'Yes' },
      { v: false, t: (labels && labels[1]) || 'No' },
      { v: null, t: (labels && labels[2]) || 'Not sure' },
    ];
    var unanswered = r[field] !== true && r[field] !== false;
    var html = '<div class="tri' + (unanswered ? ' unanswered' : '') + '" role="group">';
    opts.forEach(function (o) {
      var on = r[field] === o.v;
      html += '<button type="button" data-uid="' + r.uid + '" data-field="' + field + '"'
        + ' data-val="' + (o.v === null ? 'null' : String(o.v)) + '"'
        + ' aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(o.t) + '</button>';
    });
    return html + '</div>';
  }

  function qRow(r, field, question, labels) {
    return '<div class="q-row"><span>' + esc(question) + '</span>' + tri(r, field, labels) + '</div>';
  }

  function field(r, name, label, type, placeholder) {
    return '<div><label>' + esc(label) + '</label>'
      + '<input type="' + type + '" data-uid="' + r.uid + '" data-field="' + name + '"'
      + ' value="' + esc(r[name]) + '"'
      + (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '')
      + (type === 'number' ? ' min="0" step="0.01"' : '') + '></div>';
  }

  function render() {
    listEl.innerHTML = rows.map(function (r) {
      var meta = KINDS[r.kind] || KINDS.other;
      var html = '<li class="bill">';

      html += '<div class="bill-top">'
        + '<div><label>Who is it from</label>'
        + '<input type="text" data-uid="' + r.uid + '" data-field="provider" value="'
        + esc(r.provider) + '" placeholder="e.g. Xfinity"></div>'
        + '<div><label>Kind of bill</label><select data-uid="' + r.uid + '" data-field="kind">'
        + Object.keys(KINDS).map(function (k) {
          return '<option value="' + k + '"' + (r.kind === k ? ' selected' : '') + '>'
            + esc(KINDS[k].label) + '</option>';
        }).join('')
        + '</select></div>'
        + '<div><label>$ / month</label>'
        + '<input type="number" min="0" step="0.01" data-uid="' + r.uid + '" data-field="monthly"'
        + ' value="' + esc(r.monthly) + '"></div>'
        + '<button type="button" class="bill-rm" data-uid="' + r.uid + '" data-rm="1"'
        + ' aria-label="Remove this bill">&times;</button>'
        + '</div>';

      html += '<div class="qs">';

      if (meta.equipment) {
        html += qRow(r, 'equipmentRental', 'Do you rent the modem, router or box from them?');
        if (r.equipmentRental === true) {
          html += '<div class="detail">'
            + field(r, 'equipmentFee', '$ / month for the rental', 'number', 'e.g. 15')
            + '</div>';
        }
      }

      if (meta.promo) {
        html += qRow(r, 'promoRate', 'Are you on a promotional or introductory rate?');
        if (r.promoRate === true) {
          html += '<div class="detail">'
            + field(r, 'promoEndsOn', 'When does it end', 'date')
            + field(r, 'standardRate', '$ / month it goes to', 'number', 'if you know')
            + '</div>';
        }
      }

      if (meta.device) {
        html += qRow(r, 'deviceInstalment', 'Is there a device instalment line on the bill?');
        if (r.deviceInstalment === true) {
          html += qRow(r, 'devicePaidOff', 'Is that device already paid off?');
          if (r.devicePaidOff === true) {
            html += '<div class="detail">'
              + field(r, 'deviceFee', '$ / month for the instalment', 'number', 'e.g. 27.08')
              + '</div>';
          }
        }
      }

      if (meta.coverage) {
        html += qRow(r, 'duplicateCoverage',
          'Does anything on this policy duplicate cover you already hold (roadside, rental car)?');
        if (r.duplicateCoverage === true) {
          html += qRow(r, 'reliesOnCoverage', 'Do you rely on this policy’s version of it?');
          html += '<div class="detail">'
            + field(r, 'duplicateFee', '$ / month for that part', 'number', 'from the declarations page')
            + '</div>';
        }
      }

      if (meta.addOns) {
        html += qRow(r, 'addOnsAnswered',
          'Is there an add-on on this bill you do not use?', ['Yes', 'No', 'Not sure']);
        if (r.addOnsAnswered === true) {
          html += '<div class="detail">'
            + field(r, 'addOnLabel', 'What is it called on the bill', 'text',
              'e.g. Inside wire maintenance')
            + field(r, 'addOnMonthly', '$ / month', 'number', 'e.g. 5.99')
            + '</div>';
        }
      }

      html += qRow(r, 'autopayDiscount', 'Is an autopay or paperless discount already on the bill?');

      html += '<div class="detail"><div class="full">'
        + '<label>$ / month a year ago (optional, and the best question on this form)</label>'
        + '<input type="number" min="0" step="0.01" data-uid="' + r.uid
        + '" data-field="lastYearMonthly" value="' + esc(r.lastYearMonthly)
        + '" placeholder="from last year’s statement"></div></div>';

      html += '</div></li>';
      return html;
    }).join('');

    renderScorecard();
    renderGate();
  }

  function money(v) {
    return '$' + Number(v).toFixed(2).replace(/\.00$/, '');
  }

  function renderScorecard() {
    var emptyEl = document.getElementById('sc-empty');
    var bodyEl = document.getElementById('sc-body');
    var named = bills().filter(function (b) { return b.provider; });

    if (!named.length) {
      emptyEl.style.display = '';
      bodyEl.style.display = 'none';
      return;
    }

    var a = E.analyze({ bills: named });
    var s = E.buildScorecard(a);
    emptyEl.style.display = 'none';
    bodyEl.style.display = '';

    var cells = [
      ['Yours to stop', s.confirmedAnnual > 0 ? money(s.confirmedAnnual) + '/yr' : '—',
        s.confirmedAnnual > 0 ? 'good' : '',
        s.actionableFindings + (s.actionableFindings === 1 ? ' finding' : ' findings') + ', confirmed'],
      ['Worth a phone call', s.leverFindings || '—', '',
        s.leverFindings ? 'Never counted as a saving' : 'Nothing to chase'],
      ['Rise coming', s.promoExposureAnnual > 0 ? money(s.promoExposureAnnual) + '/yr' : '—',
        s.promoExposureAnnual > 0 ? 'warn' : '',
        'A promotion ending — not a saving'],
      ['Already risen', s.increaseAnnual > 0 ? money(s.increaseAnnual) + '/yr' : '—',
        s.increaseAnnual > 0 ? 'warn' : '',
        'Against your own bill last year'],
      ['Questions still open', s.openQuestions || '—', '',
        s.openQuestions ? 'Checks that could not run yet' : 'Every check ran'],
      ['Not priced', s.unpricedFindings || '—', '',
        s.unpricedFindings ? 'We will not estimate these' : 'Everything found has a figure'],
    ];

    bodyEl.innerHTML =
      '<div class="sc-head"><b>Your scorecard</b><span>' + named.length
        + (named.length === 1 ? ' bill' : ' bills') + ' &middot; ' + money(s.monthlySpend)
        + '/mo &middot; ' + s.checkRuns + ' checks run</span></div>'
      + '<div class="sc-lede">' + esc(s.headline) + '</div>'
      + '<div class="sc-grid">' + cells.map(function (c) {
        return '<div class="sc-cell"><span class="k">' + esc(c[0]) + '</span>'
          + '<span class="v' + (c[2] ? ' ' + c[2] : '') + '">' + esc(c[1]) + '</span>'
          + '<span class="n">' + esc(c[3]) + '</span></div>';
      }).join('') + '</div>'
      + '<div class="sc-foot">Worked out in your browser from what you typed. Nothing has been '
        + 'sent anywhere. The report reads the statements themselves, which is where the lines '
        + 'you did not know to look for come from.</div>';
  }

  // Returns true when the submission would be accepted. The same function the
  // server runs, so this can never let somebody through that the endpoint
  // would then reject — nor block somebody it would have accepted.
  function renderGate() {
    var gateEl = document.getElementById('gate');
    var result = E.checkSufficiency({ bills: bills() }, uploader.getFiles().length);
    if (result.sufficient) {
      gateEl.style.display = 'none';
      return true;
    }
    gateEl.style.display = '';
    gateEl.innerHTML = '<b>Before this can be analysed:</b><ul>'
      + result.missing.map(function (m) {
        return '<li><strong>' + esc(m.label) + '</strong> — ' + esc(m.why) + '</li>';
      }).join('')
      + '</ul>';
    return false;
  }

  /* --------------------------------------------------------------- events */

  function find(uid) {
    return rows.filter(function (r) { return r.uid === uid; })[0];
  }

  listEl.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.rm) {
      rows = rows.filter(function (r) { return r.uid !== b.dataset.uid; });
      render();
      return;
    }
    if (b.dataset.field) {
      var r = find(b.dataset.uid);
      if (!r) return;
      var v = b.dataset.val;
      r[b.dataset.field] = v === 'null' ? null : v === 'true';
      render();
    }
  });

  // `input` keeps the scorecard live as they type; re-rendering the whole list
  // on every keystroke would steal focus, so text and number fields update the
  // model and refresh only the scorecard and the gate.
  listEl.addEventListener('input', function (e) {
    var el = e.target;
    if (!el.dataset || !el.dataset.field) return;
    var r = find(el.dataset.uid);
    if (!r) return;
    r[el.dataset.field] = el.value;
    renderScorecard();
    renderGate();
  });

  // A `change` on the kind select does need a full re-render: which questions
  // apply is a function of the kind.
  listEl.addEventListener('change', function (e) {
    var el = e.target;
    if (!el.dataset || el.dataset.field !== 'kind') return;
    var r = find(el.dataset.uid);
    if (!r) return;
    r.kind = el.value;
    render();
  });

  document.getElementById('add-btn').addEventListener('click', function () {
    rows.push(blank());
    render();
  });

  document.getElementById('upload-input').addEventListener('change', function () {
    setTimeout(renderGate, 0);
  });
  document.getElementById('upload-list').addEventListener('click', function () {
    setTimeout(renderGate, 0);
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

    var href = btn.getAttribute('href') || '';
    if (href.indexOf('REPLACE_WITH_') !== -1) {
      fail('Checkout is being updated and this button is switched off rather than charging you '
        + 'the wrong price. Email hello@streamnavigator.ai and we will send you the link.');
      return;
    }

    if (!renderGate()) {
      fail('A few more details are needed first — see the list above.');
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
        product: 'home-savings',
        email: email,
        formData: { bills: bills() },
        files: uploader.getFiles(),
      });
      goToStripe(href, { id: submission.id, token: submission.token, product: 'home-savings' }, email);
    } catch (err) {
      fail((err && err.message) || 'Something went wrong — please try again.');
      btn.textContent = original;
      btn.style.pointerEvents = 'auto';
    }
  });

  // Two empty rows to start. An empty list with an "add" button reads as a
  // form that has not loaded; two rows read as a form that wants filling in.
  rows.push(blank({ kind: 'internet' }));
  rows.push(blank({ kind: 'mobile' }));
  render();
}());
