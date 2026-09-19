/* government-money-intake.js — the form, the free scorecard and the checkout
   gate for /government-money.

   Every decision here is made by navigator-government-money-engine.js, which
   is the same file api/navigator-intake.js loads. Nothing in this file decides
   whether a program applies, and nothing in it decides whether a customer may
   pay: it collects answers, hands them to the engine, and renders what comes
   back. That is deliberate — two copies of those rules is the drift that let a
   customer reach checkout with input the server then rejected.

   The scorecard is computed here, in the browser, and nothing is sent
   anywhere to produce it. That is why it can be free.
*/
(function () {
  'use strict';

  var E = window.GovernmentMoneyEngine;
  var CAT = null;

  var answers = {
    state: '', zip: '', tenure: null, householdSize: null, incomeBand: '',
    taxLiability: null, alreadyClaimed: null,
    actionsDone: [], actionsPlanned: [], events: [],
    utility: '', description: '',
  };

  /* ------------------------------------------------------------ the catalogue */

  // The gate does NOT need this, which is the point of fetching it separately:
  // a customer can always be told what is missing and can always be stopped
  // from paying, even if this request never lands. Only the free scorecard
  // depends on it, and a scorecard that cannot be drawn says so.
  function loadCatalogue() {
    return fetch('/data/government-programs.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) {
        if (!json) return null;
        CAT = E.load(json);
        render();
        return CAT;
      })
      .catch(function () { return null; });
  }

  /* ---------------------------------------------------------------- the form */

  function el(id) { return document.getElementById(id); }

  function fillSelect(node, options) {
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0];
      opt.textContent = o[1];
      node.appendChild(opt);
    });
  }

  function wireSegment(id, key) {
    var box = el(id);
    box.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) {
        b.setAttribute('aria-pressed', String(b === btn));
      });
      answers[key] = btn.dataset.v;
      box.classList.remove('unanswered');
      render();
    });
  }

  function wireTicks(id, key, items, noneLabel) {
    var box = el(id);
    items.forEach(function (it) {
      var label = document.createElement('label');
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.value = it[0];
      label.appendChild(input);
      label.appendChild(document.createTextNode(' ' + it[1]));
      box.appendChild(label);
    });
    // "Nothing" is a real answer and has to be tickable, because an empty list
    // we were given means none and an absent one means nobody asked. The
    // engine's sufficiency check draws exactly that distinction.
    var none = document.createElement('label');
    var noneInput = document.createElement('input');
    noneInput.type = 'checkbox';
    noneInput.value = '__none__';
    none.appendChild(noneInput);
    none.appendChild(document.createTextNode(' ' + noneLabel));
    box.appendChild(none);

    box.addEventListener('change', function (e) {
      var boxes = Array.prototype.slice.call(box.querySelectorAll('input'));
      if (e.target === noneInput && noneInput.checked) {
        boxes.forEach(function (b) { if (b !== noneInput) b.checked = false; });
      } else if (e.target !== noneInput && e.target.checked) {
        noneInput.checked = false;
      }
      answers[key] = boxes
        .filter(function (b) { return b.checked && b.value !== '__none__'; })
        .map(function (b) { return b.value; });
      // Ticking "nothing" answers the question with an empty list; unticking
      // everything leaves it unanswered.
      answers[key + '__answered'] = noneInput.checked || answers[key].length > 0;
      render();
    });
  }

  function pairs(map, order) {
    return (order || Object.keys(map)).map(function (k) { return [k, map[k]]; });
  }

  function build() {
    fillSelect(el('q-state'), E.PLACES.map(function (p) { return [p[1], p[0]]; }));
    fillSelect(el('q-income'), E.INCOME_BANDS
      .filter(function (b) { return b !== 'prefer-not-say'; })
      .map(function (b) { return [b, E.INCOME_LABELS[b]]; })
      .concat([['prefer-not-say', 'I would rather not say']]));

    el('q-state').addEventListener('change', function (e) { answers.state = e.target.value; render(); });
    el('q-income').addEventListener('change', function (e) { answers.incomeBand = e.target.value; render(); });
    el('q-zip').addEventListener('input', function (e) { answers.zip = e.target.value.trim(); render(); });
    el('q-size').addEventListener('input', function (e) { answers.householdSize = e.target.value; render(); });
    el('q-utility').addEventListener('input', function (e) { answers.utility = e.target.value.trim(); });
    el('intake-description').addEventListener('input', function (e) { answers.description = e.target.value; });

    wireSegment('q-tenure', 'tenure');
    wireSegment('q-liability', 'taxLiability');
    wireSegment('q-claimed', 'alreadyClaimed');

    var actionOrder = Object.keys(E.ACTION_LABELS);
    wireTicks('q-done', 'actionsDone', pairs(E.ACTION_LABELS, actionOrder), 'Nothing in the last two years');
    wireTicks('q-planned', 'actionsPlanned', pairs(E.ACTION_LABELS, actionOrder), 'Nothing planned');
    wireTicks('q-events', 'events', pairs(E.EVENT_LABELS), 'None of these');
  }

  /* --------------------------------------------------------- what we hand over */

  // The engine distinguishes an empty list from an absent one, so the absent
  // case has to survive the trip: a checklist nobody has touched is not sent
  // as [].
  function formData() {
    var out = {
      state: answers.state,
      zip: answers.zip,
      tenure: answers.tenure,
      householdSize: answers.householdSize ? Number(answers.householdSize) : null,
      incomeBand: answers.incomeBand,
      taxLiability: answers.taxLiability,
      alreadyClaimed: answers.alreadyClaimed,
      utility: answers.utility,
      description: answers.description,
    };
    if (answers.actionsDone__answered) out.actionsDone = answers.actionsDone;
    if (answers.events__answered) out.events = answers.events;
    out.actionsPlanned = answers.actionsPlanned__answered ? answers.actionsPlanned : [];
    return out;
  }

  /* ------------------------------------------------------------ the scorecard */

  function cell(k, v, n, good) {
    return '<div class="sc-cell"><span class="k">' + k + '</span>'
      + '<span class="v' + (good ? ' good' : '') + '">' + v + '</span>'
      + (n ? '<span class="n">' + n + '</span>' : '') + '</div>';
  }

  function plural(n, one, many) { return n === 1 ? one : many; }

  function renderScorecard() {
    var empty = el('sc-empty');
    var body = el('sc-body');
    if (!CAT) {
      empty.textContent = 'Your scorecard is loading. If it does not appear, the questions above '
        + 'still work and the full report is unaffected — it is worked out on our side.';
      empty.style.display = '';
      body.style.display = 'none';
      return;
    }

    var snap = E.buildSnapshot(formData());
    if (!snap.ready) {
      empty.textContent = 'Answer the questions above and your scorecard appears here, worked out '
        + 'in your browser. Nothing is sent anywhere until you choose to buy the report.';
      empty.style.display = '';
      body.style.display = 'none';
      return;
    }

    var t = snap.totals;
    var lede = t.shortlist
      ? '<strong>' + t.shortlist + ' ' + plural(t.shortlist, 'program', 'programs')
        + '</strong> your answers point at directly, and ' + t.toConfirm + ' more worth confirming.'
      : t.toConfirm
        ? '<strong>Nothing fits outright</strong>, but ' + t.toConfirm + ' '
          + plural(t.toConfirm, 'program is', 'programs are') + ' worth confirming.'
        : '<strong>Your answers point at nothing on this list.</strong> That is a result, and the '
          + 'report shows the fact that rules each of the ' + t.ruledOut + ' out.';

    var notes = [];
    if (snap.hasStacking) notes.push('a utility rebate and a federal credit that must not be added together');
    if (snap.hasSharedCap) notes.push('two lines sharing one annual ceiling');
    if (snap.notNowDated) notes.push(snap.notNowDated + ' dated ' + plural(snap.notNowDated, 'line', 'lines'));

    body.innerHTML = '<div class="sc-head"><b>Your scorecard</b><span>Worked out in your browser · '
      + t.considered + ' programs considered</span></div>'
      + '<div class="sc-lede">' + lede + '</div>'
      + '<div class="sc-grid">'
      + cell('On your shortlist', String(t.shortlist), 'your answers meet every condition we can check', t.shortlist > 0)
      + cell('Worth confirming', String(t.toConfirm), 'likely, with one condition we cannot settle for you')
      + cell('Not this year', String(t.notNow), 'ruled out now, with the thing that would change it')
      + cell('Ruled out', String(t.ruledOut), 'each with the specific fact that did it')
      + '</div>'
      + '<div class="sc-foot">'
      + (notes.length ? 'The report also flags ' + notes.join(', ') + '. ' : '')
      + 'Federal: ' + snap.scopes.federal + ' · State and county: ' + snap.scopes.state
      + ' · Utility: ' + snap.scopes.utility
      + (snap.openQuestions ? ' · ' + snap.openQuestions + ' open '
        + plural(snap.openQuestions, 'question', 'questions') + ' you could still answer above' : '')
      + '</div>';
    empty.style.display = 'none';
    body.style.display = '';
  }

  /* ------------------------------------------------------------------ the gate */

  function renderGate() {
    var box = el('gate');
    var s = E.checkSufficiency(formData());
    if (s.sufficient) { box.style.display = 'none'; return true; }
    box.innerHTML = '<b>A few more answers first.</b> ' + s.message;
    box.style.display = '';
    return false;
  }

  function render() {
    renderScorecard();
    // The gate box only appears once somebody has started, so an untouched
    // form does not open with a complaint.
    var started = answers.state || answers.tenure || answers.taxLiability
      || answers.actionsDone__answered;
    if (started) renderGate(); else el('gate').style.display = 'none';
  }

  /* ---------------------------------------------------------------- checkout */

  function start() {
    if (!E) return;
    build();
    render();
    loadCatalogue();

    var uploader = wireUploadZone(el('upload-zone'), el('upload-input'), el('upload-list'));

    el('final-cta').addEventListener('click', function (e) {
      e.preventDefault();
      el('price').scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(function () { el('q-state').focus(); }, 420);
    });

    el('pay-btn').addEventListener('click', async function (e) {
      e.preventDefault();
      var btn = e.currentTarget;
      var errEl = el('intake-error');
      function fail(msg, focusEl) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
        showToast(msg);
        if (focusEl) focusEl.focus();
      }
      errEl.style.display = 'none';

      // A placeholder link is never followed. There is a real link today, and
      // this stays because the last two price moves both went through one —
      // showing a customer one price and charging another is the defect
      // scripts/check-prices.js exists for, and this is its runtime half.
      var href = btn.getAttribute('href') || '';
      if (href.indexOf('REPLACE_WITH_') !== -1) {
        fail('Checkout is being updated and this button is switched off rather than charging you '
          + 'the old price. Email hello@streamnavigator.ai and we will send you the link.');
        return;
      }

      var emailEl = el('intake-email');
      var email = emailEl.value.trim();
      if (!email || email.indexOf('@') === -1) { fail('Enter a valid email so we can reach you.', emailEl); return; }

      // The same gate api/navigator-intake.js enforces — both load
      // navigator-government-money-engine.js, so a customer cannot reach
      // checkout with input the server would reject. Before this existed, a
      // single character reached a $39 checkout.
      if (!renderGate()) {
        fail('A few more answers are needed first — see the note above.');
        el('gate').scrollIntoView({ block: 'center' });
        return;
      }

      var files = uploader.getFiles();
      var originalText = btn.textContent;
      btn.textContent = 'Saving your submission…';
      btn.style.pointerEvents = 'none';
      try {
        var submission = await submitNavigatorIntake({
          product: 'government-money',
          email: email,
          formData: formData(),
          files: files,
        });
        goToStripe(href, { id: submission.id, token: submission.token, product: 'government-money' }, email);
      } catch (err) {
        fail(err.message || 'Something went wrong — please try again.');
        btn.textContent = originalText;
        btn.style.pointerEvents = 'auto';
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
