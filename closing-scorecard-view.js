// The free scorecard renderer, shared by two pages.
//
// It used to live inside closing.html only. The scorecard now opens on its own
// URL (closing-scorecard.html) so a customer can bookmark it, send it to their
// spouse or their agent, and come back to it -- none of which worked when it
// was a hidden div on the upload page. Two pages rendering the same panel from
// two copies of this code is exactly the drift this codebase keeps paying for,
// so there is one copy and both pages load it.
//
// State that belongs to the surrounding page (which answers were given, whether
// the customer has acknowledged unread figures) is passed in and read back
// through the returned object rather than reached for as a closure variable.
'use strict';

(function (global) {

  // ctx:
  //   answers       -- the live savedAnswers object; read for transaction_type
  //   showUploader  -- called by the "add those documents" button. Optional:
  //                    on the standalone page there is no uploader to return
  //                    to, so it navigates back to /closing instead.
  function createScorecardView(ctx) {
    const answers = (ctx && ctx.answers) || {};
    const showUploader = (ctx && ctx.showUploader) || function () {
      // #upload lands the customer on the upload box rather than the top of a
      // long marketing page they have already read.
      global.location.href = '/closing#upload';
    };
    const restoreAnswers = (ctx && ctx.restoreAnswers) || null;

    // Set on every render. The pay handler reads them back through the returned
    // object; a fresh scorecard means a fresh decision about unread figures.
    let unreadableRemaining = 0;
    let acknowledgedGaps = false;

    const money = (n) => n === null || n === undefined
      ? '—'
      : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

    function applyTier(tier) {
      const btn = document.getElementById('pay-btn');
      const link = btn.getAttribute('data-link-full');
      if (link && link.indexOf('REPLACE_WITH_') === -1) btn.setAttribute('href', link);
      btn.textContent = 'Unlock the Full Audit — $59 →';
    }

    function renderScorecard(sc) {
      // Nothing offered to a refinancing customer should mention a purchase
      // contract; there is never one, so the offer reads as not having listened.
      const isRefi = (answers.transaction_type || '') === 'refinance';
      unreadableRemaining = (sc.unreadable_fields || []).length;
      acknowledgedGaps = false;   // a fresh scorecard means a fresh decision
      const panel = document.getElementById('scorecard-panel');
      const pct = sc.closing_costs_pct_of_loan;
      const rows = [];

      if (sc.total_closing_costs !== null && sc.total_closing_costs !== undefined) {
        rows.push(['Total closing costs', money(sc.total_closing_costs)]);
        rows.push(['As a share of your loan', pct === null ? '—' : pct + '%']);
        // A bare percentage tells a first-time buyer nothing. Say what normal is,
        // and say why a small loan reads high — many fees are flat dollars.
        if (sc.cost_context) {
          var cc = sc.cost_context;
          rows.push(['Typical range', cc.typical_low + '–' + cc.typical_high + '% of loan']);
        }
      } else if (sc.total_borrower_charges) {
        // A settlement statement prints no Total Closing Costs line, so this is
        // added up from the charge lines. Labelled as calculated so it is never
        // mistaken for the lender's own total.
        rows.push([
          'Your fees and charges (' + sc.charge_lines_counted + ' lines)',
          money(sc.total_borrower_charges),
        ]);
        if (sc.loan_amount) {
          rows.push([
            'As a share of your loan',
            Math.round((sc.total_borrower_charges / sc.loan_amount) * 1000) / 10 + '%',
          ]);
        }
      }

      rows.push(['Potential issues found', String(sc.flag_count)]);
      // Three issues could be $50 or $5,000. Without magnitude the decision to
      // pay is a coin flip.
      if (sc.flag_dollars) {
        rows.push(['Dollars in question', money(sc.flag_dollars)
          + (sc.flags_with_dollars < sc.flag_count ? ' (' + sc.flags_with_dollars + ' of ' + sc.flag_count + ' priced)' : '')]);
      }
      if (sc.flag_severity && sc.flag_severity.high) {
        rows.push(['Of those, high priority', String(sc.flag_severity.high)]);
      }
      if (sc.needs_more_documents_count) {
        rows.push(['Items needing another document', String(sc.needs_more_documents_count)]);
      }
      // Checks, not fees. "10 of 14 fees, no rate data" measured a corpus we do
      // not claim to have, and its denominator was never reachable. This one is.
      //
      // The denominator is now what the customer's OWN documents can reach, not
      // the whole catalog. "20 of 27" described a complete audit of a Closing
      // Disclosure as three-quarters finished, because the other 7 needed a Loan
      // Estimate nobody had asked for. Completeness is one statement and the
      // upsell is another; the fraction was carrying both and reading as a
      // failure. The blocked checks are now an addition below, not a shortfall
      // above.
      // No "Checks run" row: the sentence under this list states the same
      // fraction in words, and printing it twice made the page look like it was
      // arguing with itself.
      if (typeof sc.findings_count === 'number') {
        rows.push(['Findings to review', String(sc.findings_count)]);
      }

      // Shown ABOVE the figures and at a size that cannot be skimmed past. Someone
      // comparing two different properties' documents needs to know that before
      // they read a single number, or they will trust findings built on the wrong
      // pairing.
      let html = '';
      if (sc.transaction_mismatch) {
        const m = sc.transaction_mismatch;
        const rows = (m.fields || []).map(function(f){
          return '<li><span>' + f.field + '</span>'
            + '<b>' + (f.cd === null || f.cd === undefined ? 'not stated' : f.cd) + '</b>'
            + '<em>on your Closing Disclosure</em>'
            + '<b>' + (f.le === null || f.le === undefined ? 'not stated' : f.le) + '</b>'
            + '<em>on your Loan Estimate</em></li>';
        }).join('');
        html += '<div class="scorecard-alert">'
          + '<h3>These two documents are not the same loan</h3>'
          + '<p>We stopped the comparison rather than give you findings that mean nothing.</p>'
          + (rows ? '<ul class="mismatch-rows">' + rows + '</ul>' : '')
          + '<p class="mismatch-why">A Loan Estimate is a promise made by one particular lender about '
          + 'one particular property. Comparing it against a different loan\'s charges would produce '
          + 'numbers that look like violations but are meaningless. Upload the Loan Estimate for this '
          + 'property and lender, and we will run the comparison.</p>'
          + '</div>';
      }

      html += '<div class="scorecard-head"><strong>Your free scorecard</strong>'
        + (sc.document_label ? ' &middot; read from your ' + sc.document_label : '')
        + (sc.property_county ? ' &middot; ' + sc.property_county + (sc.property_state ? ', ' + sc.property_state : '') : '')
        + '</div><ul class="scorecard-rows">'
        + rows.map(r => '<li><span>' + r[0] + '</span><b>' + r[1] + '</b></li>').join('')
        + '</ul>';

      // Says what the count means, in a sentence, immediately under it. A bare
      // fraction invites the reader to supply their own denominator, and the one
      // they supply is "out of everything you could have checked".
      if (sc.checks_total) {
        var reached = sc.checks_reachable || sc.checks_in_scope || sc.checks_total;
        var didRun = sc.checks_attempted || sc.checks_run || 0;
        var docLabel = sc.document_label || 'Closing Disclosure';
        var by = sc.checks_blocked_by || [];
        var line = '<strong>' + didRun + ' of ' + reached + ' checks that apply to your '
          + escH(docLabel) + '.</strong>';
        // "That is all of them" belongs only where there is genuinely nothing
        // left. Printed while seven more were listed underneath, it read as the
        // page contradicting itself one line later.
        if (didRun >= reached && !by.length) line += ' That is all of them.';

        // The blocked checks are an addition, phrased as what each document buys.
        if (by.length) {
          // A customer who uploaded a Loan Estimate for the wrong house was told
          // to "add your Loan Estimate". They added one. The ask is to replace
          // it, and telling them to add reads as though we did not notice.
          var supplied = {
            'your Loan Estimate': Boolean(sc.loan_estimates_uploaded),
            'your purchase contract': Boolean(sc.contract_uploaded),
          };
          line += ' ' + by.map(function (b) {
            // Documents are added or replaced; questions are answered.
            if (/answer/i.test(b.document)) return b.count + ' more if you ' + escH(b.document);
            var verb = supplied[b.document] ? 'if you replace ' : 'if you add ';
            return b.count + ' more ' + verb + escH(b.document);
          }).join(', and ') + '.';
        }
        html += '<p class="scorecard-note">' + line + '</p>';
      }

      // Only meaningful when we added the total up ourselves. A real Closing
      // Disclosure prints Total Closing Costs (J), and J already includes the
      // initial escrow payment in section G — telling the customer those were
      // "not counted above" would be flatly untrue.
      // Tier is decided by what the customer actually uploaded, and the upsell is
      // shown only when it would genuinely buy them a different analysis.
      if (sc.tier) {
        applyTier(sc.tier);
        // A contract that simply promises the buyer nothing is not a document we
        // "could not use". Saying so contradicts the note below it, which tells
        // the same customer their contract read fine and had nothing in it.
        var contractEmptyNotBroken = sc.contract_uploaded && !sc.contract_reconciled
          && !sc.contract_low_confidence
          && !(sc.contract_mismatch && sc.contract_mismatch.length)
          && !sc.contract_terms_read;
        var onlyContractMissing = contractEmptyNotBroken && !sc.tier.has_loan_estimate;

        if (sc.tier.id === 'basic' && sc.tier.downgraded_from_full && !onlyContractMissing) {
          // The extra document could not be used, so those checks did not run.
          // Price is flat, so this is a coverage message, not a billing one.
          // Saying so plainly is the difference between a refund request and a
          // customer who fixes the upload and comes back.
          html += '<p class="scorecard-note"><strong>Some checks did not run.</strong> You uploaded '
            + (sc.tier.has_loan_estimate && sc.tier.has_purchase_contract ? 'extra documents'
              : sc.tier.has_loan_estimate ? 'a Loan Estimate' : 'a purchase contract')
            + ', but we could not use '
            + (sc.tier.has_loan_estimate && sc.tier.has_purchase_contract ? 'them' : 'it')
            // Said "the reason is above". It is not: this panel is written before
            // the address-mismatch and unreadable-document notes, so the reason
            // prints underneath it. Pointing a confused customer in the wrong
            // direction on the one screen explaining why their upload failed.
            // Direction removed rather than reordered -- the panels are ordered
            // most-specific-first on purpose, and "below" would break the moment
            // one of them moves again.
            + ' &mdash; see the explanation on this page. Replace the upload and those checks run too, at no '
            + 'extra cost. The price is $59 either way.</p>'
            + '<p class="scorecard-note">You still get every check that runs on the Closing '
            + 'Disclosure alone.</p>'
            + '<button type="button" class="btn btn-ghost btn-sm js-add-docs" '
            + 'style="margin-top:10px;">&#8593; Replace those documents</button>';
        } else if (sc.tier.id === 'basic') {
          html += '<div class="sc-panel">'
            + '<p class="sc-h">Your audit is $59</p>'
            // The count comes from the scorecard, not from this copy. A hardcoded
            // number drifts the moment a check is added or retired, and an
            // overstated one is the claim a customer checks first.
            + '<p class="sc-sub">' + (sc.checks_run || 0) + ' checks already ran. '
            + 'Paying shows what each one found.</p>'
            + '<ul class="sc-list">'
            + '<li><b>Loan Calculations box</b> &mdash; APR, finance charge, TIP, recomputed</li>'
            + '<li><b>Escrow cushion</b> &mdash; against the RESPA legal maximum</li>'
            + '<li><b>Per-diem interest and prorations</b> &mdash; from your closing date</li>'
            + '<li><b>Duplicate and stacked fees</b> &mdash; named</li>'
            + '<li><b>Cash to Close</b> &mdash; reconciled</li>'
            + '<li><b>An email to your lender</b> &mdash; already written</li>'
            + '</ul>'
            + '</div>';
        } else {
          // Said "You uploaded Loan Estimates" whether one arrived or five. The
          // sentence sits beside the price, which is the worst place on the page
          // to look careless about counting.
          var leWord = (sc.loan_estimates_read || sc.loan_estimates_uploaded) === 1
            ? 'a Loan Estimate' : 'Loan Estimates';
          html += '<p class="scorecard-note"><strong>Your audit is $59.</strong> You uploaded '
            + (sc.tier.has_loan_estimate && sc.tier.has_purchase_contract
                ? leWord + ' and a purchase contract, so tolerance testing and credit reconciliation both apply'
                : sc.tier.has_loan_estimate
                  ? leWord + ', so TRID tolerance testing has already run against the correct baseline'
                  : 'a purchase contract, so we have checked your negotiated credits against the closing figures')
            + '.</p>';
        }
      }

      if (sc.loan_estimates_uploaded && !sc.tolerance_tested) {
        if (sc.tolerance_blocked_reason === 'different_address') {
          // The one case where the customer has simply uploaded the wrong file.
          // Stated first, in its own panel, naming both addresses — telling them
          // to find a clearer scan of a document for another house is the least
          // useful thing this page could say.
          html += '<p class="scorecard-warn"><strong>Your Closing Disclosure and Loan Estimate '
            + 'are not for the same address.</strong> '
            + (sc.address_mismatch && sc.address_mismatch.cd && sc.address_mismatch.le
                ? 'The Closing Disclosure is for ' + escH(sc.address_mismatch.cd)
                  + ' and the Loan Estimate is for ' + escH(sc.address_mismatch.le) + '. '
                : '')
            + 'Tolerance testing compares the fees you were quoted against the fees you were '
            + 'charged, so both documents have to describe the same property. Upload the Loan '
            + 'Estimate for this property and those checks run at no extra cost.</p>';
        } else if (sc.tolerance_blocked_reason === 'different_loan') {
          // already stated prominently above; do not repeat it in small print
        } else
        html += '<p class="scorecard-warn"><strong>Tolerance testing did not run.</strong> '
          + (sc.tolerance_blocked_reason === 'different_loan'
              ? 'The Loan Estimate you uploaded appears to be for a different loan'
                + (sc.transaction_mismatch && sc.transaction_mismatch.cd_lender && sc.transaction_mismatch.le_lender
                    ? ' — your Closing Disclosure is from ' + sc.transaction_mismatch.cd_lender
                      + ', but the Loan Estimate is from ' + sc.transaction_mismatch.le_lender
                    : '')
                + '. A Loan Estimate is a promise by one particular lender, so comparing it against a '
                + 'different lender\'s charges would produce findings that mean nothing. Upload the '
                + 'Loan Estimate for this loan and we will run the comparison.'
              : sc.tolerance_blocked_reason === 'no_cd_charges'
              ? 'We read your Loan Estimate, but no individual charges could be read from your Closing '
                + 'Disclosure — page 2 carries the closing cost details and it appears to be missing or '
                + 'unreadable. There was nothing to compare the Loan Estimate against.'
              : 'We could not read your Loan Estimate'
                + (sc.loan_estimates_uploaded === 1 ? '' : 's')
                + ' clearly enough, or no issue date was printed — we need that to work out which one '
                + 'sets the legal baseline.')
          + ' Upload a complete copy and we will run it. This is not a clean result for those checks.</p>';
      }

      // The same trap without a Loan Estimate: no charge lines means most of the
      // audit could not run, and a flag count of zero would read as a clean bill.
      if (!sc.loan_estimates_uploaded && sc.cd_charge_lines === 0) {
        html += '<p class="scorecard-warn"><strong>No individual charges could be read.</strong> '
          + 'Page 2 of the Closing Disclosure carries the closing cost details, and it appears to be '
          + 'missing or unreadable in what you uploaded. Most of the audit needs those lines, so a '
          + 'count of zero here does not mean your closing is clean.</p>';
      }

      if (sc.contract_low_confidence) {
        html += '<p class="scorecard-warn"><strong>Part of your contract could not be read reliably.</strong> '
          + 'We discarded ' + sc.contract_low_confidence + ' term'
          + (sc.contract_low_confidence === 1 ? '' : 's')
          + ' rather than risk reporting a credit you never negotiated, or missing one you did. '
          + 'A clearer copy of the contract — the original PDF from your agent rather than a scan '
          + '— would let us check those.</p>';
      }
      if (sc.contract_uploaded && !sc.contract_reconciled) {
        // A contract that was read cleanly and simply does not promise the buyer
        // anything is the ordinary case, not a failure. Telling that customer we
        // "could not read" their contract sends them hunting for a better scan of
        // a document that was already perfectly legible, and leaves them thinking
        // part of what they are about to pay for is broken.
        //
        // The three cases are distinguishable: a mismatch names the fields, an
        // unreadable contract leaves low-confidence terms behind, and a contract
        // with nothing in it produces neither.
        var nothingToReconcile = !sc.contract_low_confidence
          && !(sc.contract_mismatch && sc.contract_mismatch.length)
          && !sc.contract_terms_read;
        if (nothingToReconcile) {
          html += '<p class="scorecard-note"><strong>Your contract states no seller credits or '
            + 'concessions.</strong> We read it and found nothing the seller agreed to pay toward '
            + 'your costs, so there is nothing to check against the Closing Disclosure. That is a '
            + 'normal result, not a problem &mdash; if you did negotiate a credit, it may sit in an '
            + 'addendum that was not included, and adding that page would let us check it.</p>';
        } else {
          html += '<p class="scorecard-warn"><strong>Contract reconciliation did not run.</strong> '
            + (sc.contract_mismatch && sc.contract_mismatch.length
                // Read "property address differ" -- one field, plural verb -- on
                // the screen asking the customer to trust our arithmetic.
                ? (function () {
                    var fields = sc.contract_mismatch.map(function (m) { return m.field; });
                    var addr = null;
                    for (var i = 0; i < sc.contract_mismatch.length; i++) {
                      var m = sc.contract_mismatch[i];
                      if (m.field === 'property address' && m.cd && m.le) { addr = m; break; }
                    }
                    return 'The contract you uploaded does not match this Closing Disclosure &mdash; the '
                      + fields.join(' and ')
                      + (fields.length === 1 ? ' does not match' : ' do not match') + '. '
                      // The Loan Estimate version names both addresses; this one
                      // named neither, so a customer was told their contract was
                      // for a different house without being told which house --
                      // no way to tell a wrong file from a misread one.
                      + (addr
                          ? 'The Closing Disclosure is for ' + escH(addr.cd)
                            + ' and the contract is for ' + escH(addr.le) + '. '
                            + 'Upload the contract for this property and those checks run at no extra cost.'
                          : 'Upload the contract for this closing and those checks run at no extra cost.');
                  }())
                : 'We could not read any credits, concessions or cost allocations from the contract — '
                  + 'it may be missing pages or an addendum.')
            + ' This is not a clean result for those checks.</p>';
        }
      }

      // One line until clicked. Every item is still here: these are not passes,
      // and a customer who wants the detail must be able to get all of it.
      if (sc.checks_skipped_detail && sc.checks_skipped_detail.length) {
        var n = sc.checks_skipped_detail.length;
        html += '<details class="sc-details"><summary>' + n + ' check'
          + (n === 1 ? '' : 's') + ' we could not run &mdash; tap to see which</summary>'
          + '<ul class="sc-list">';
        for (var si = 0; si < n; si++) {
          html += '<li>' + escH(sc.checks_skipped_detail[si]) + '</li>';
        }
        html += '</ul><p class="sc-sub">These are not passes. We could not test them at all.</p>'
          + '</details>';
      }

      if (sc.deposits_excluded && sc.total_is_derived) {
        html += '<p class="scorecard-note">Not counted above: ' + money(sc.deposits_excluded.total)
          + ' in deposits or holdbacks across ' + sc.deposits_excluded.count + ' line'
          + (sc.deposits_excluded.count === 1 ? '' : 's') + '. That is your own money set aside, '
          + 'not a fee, so including it would overstate what this closing costs you.</p>';
      }

      if (sc.checks_unavailable && sc.checks_unavailable.length) {
        html += '<p class="scorecard-warn"><strong>Some checks need your Closing Disclosure.</strong> '
          + 'A settlement statement carries the charges but not your loan terms, section subtotals or '
          + 'escrow disclosure, so we could not test: ' + sc.checks_unavailable.join(', ')
          + '. Upload the Closing Disclosure too and those run as well.</p>';
      }

      if (sc.unreadable_fields && sc.unreadable_fields.length) {
        // We report what we could not read; we do not ask the customer to key it
        // in. A figure they type is unverified, and a finding resting on it is
        // weaker than no finding at all — it puts their own typo in an email to
        // their lender under our name.
        html += '<div class="scorecard-warn"><strong>We could not read '
          + sc.unreadable_fields.length + ' figure'
          + (sc.unreadable_fields.length === 1 ? '' : 's') + '.</strong> '
          + 'We excluded '
          + (sc.unreadable_fields.length === 1 ? 'it' : 'them')
          + ' rather than guessing, so any check that needed '
          + (sc.unreadable_fields.length === 1 ? 'it' : 'them')
          + ' did not run. A clearer copy from your lender\'s portal usually reads '
          + 'cleanly \u2014 you can re-upload at no charge.</div>';
      }

      // Self-contained escaper: these strings are server-side constants today,
      // but a future unlock could carry a filename and this file builds HTML by
      // string concatenation.
      // The service writes full sentences ("We compare these against ... : A, B").
      // The bullet label already carries that, so keep only what follows the colon.
      // Declared with `function`, not `var`, on purpose. A `var` assignment only
      // exists from its own line onward, so moving any call site above it -- which
      // is exactly what the footer redesign did -- makes it undefined at runtime
      // while still parsing cleanly. A function declaration hoists to the top of
      // the enclosing function and cannot break that way.
      function stripLead(s) {
        var i = String(s || '').indexOf(': ');
        return i === -1 ? String(s || '') : String(s).slice(i + 2);
      }

      function escH(v) {
        return String(v == null ? '' : v)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      // What we could and could not price, as a short bulleted list rather than
      // three paragraphs of small grey prose.
      if (sc.benchmark_coverage) {
        var bc = sc.benchmark_coverage;
        var covItems = '';
        if (bc.priced_sentence) {
          covItems += '<li><b>Priced against a published rate or statute:</b> '
            + escH(stripLead(bc.priced_sentence)) + '</li>';
        }
        if (bc.distribution_sentence) {
          covItems += '<li><b>Compared with what similar loans paid:</b> '
            + escH(stripLead(bc.distribution_sentence)) + '</li>';
        }
        if (bc.not_priced_sentence) {
          covItems += '<li><b>Not priced'
            + (bc.jurisdiction ? ' in ' + escH(bc.jurisdiction) : '') + ':</b> '
            + escH(stripLead(bc.not_priced_sentence)) + '</li>';
        }
        if (covItems) {
          html += '<div class="sc-panel"><p class="sc-h">What we measured against</p>'
            + '<ul class="sc-list">' + covItems + '</ul>'
            + (sc.evidence_basis ? '<p class="sc-sub">' + escH(sc.evidence_basis) + '</p>' : '')
            + '</div>';
        }
      } else if (sc.evidence_basis) {
        html += '<div class="sc-panel"><p class="sc-h">What we measured against</p>'
          + '<p class="sc-lead">' + escH(sc.evidence_basis) + '</p></div>';
      }

      // (rendered above, inside the "What we measured against" panel)

      // Every blocked check names a document the page can accept, so none of
      // these is a dead end.
      if (sc.unlocks && sc.unlocks.length) {
        var docUnlocks = 0;
        for (var di = 0; di < sc.unlocks.length; di++) {
          if (sc.unlocks[di].accepts !== 'answers') docUnlocks += sc.unlocks[di].unlocks_count;
        }
        html += '<div class="sc-panel sc-panel-accent">'
          + '<p class="sc-h">What would unlock more</p><ul class="sc-list">';
        for (var ui = 0; ui < sc.unlocks.length; ui++) {
          var u = sc.unlocks[ui];
          html += '<li><b>' + escH(u.title) + '</b> &mdash; unlocks ' + u.unlocks_count
            + (u.unlocks_count === 1 ? ' check. ' : ' checks. ') + escH(u.why) + '</li>';
        }
        // The button belongs HERE, beside the checks it unlocks. The footer
        // redesign dropped it and turned this panel into a dead end -- the exact
        // failure the product notes flagged as "upsells with nowhere to upload".
        if (docUnlocks > 0) {
          html += '</ul>'
            + '<button type="button" class="btn btn-ghost btn-sm js-add-docs" '
            + 'style="margin-top:12px;">&#8593; Add those documents &mdash; still free</button>'
            // Uploading is free and re-scores immediately, but a usable Loan
            // Estimate or contract moves the paid report to $59. Saying that on
            // the button that raises it is the difference between an upgrade and
            // a bait-and-switch.
            + '<p class="sc-sub">Adding documents is free, updates this scorecard right away, '
            + 'and does not change the price. It only adds checks.</p>'
            + '</div>';
        } else {
          html += '</ul></div>';
        }
      }

      html += sc.flag_count > 0
        // Narrower than it was. The old wording promised "what it should be, the rule
        // or schedule we measured it against, the dollar impact" for every finding —
        // contradicting the paragraph directly above, which had just explained that
        // for unbenchmarkable fees there is no "should be" and no schedule.
        // Replaced a paragraph describing the product with one describing the
        // customer's own closing. Every line has to earn its place with a fact
        // from their documents.
        ? '<p class="scorecard-note">'
          + (sc.flag_dollars
              ? 'We can put a figure on ' + money(sc.flag_dollars) + ' of what we flagged'
                + (sc.flags_with_dollars < sc.flag_count
                    ? '; the other ' + (sc.flag_count - sc.flags_with_dollars) + ' need a question answered before a number can be attached'
                    : '')
                + '. '
              : 'None of what we flagged can be priced from this document alone &mdash; each needs a '
                + 'question answered first. ')
          + 'The full audit names each charge, what we measured it against, whether you can still '
          + 'change it before you close, and gives you the email to send.</p>'
        : (sc.cd_charge_lines === 0
          ? '<p class="scorecard-note">We could not read the individual charges from this document, so '
            + 'the fee-level checks did not run. This is not a clean result — upload a complete copy '
            + 'including page 2.</p>'
          : sc.tolerance_tested
            // Tolerance testing has already run against the Loan Estimates. Say so,
            // so the count means what the customer thinks it means.
            ? '<p class="scorecard-note">No issues surfaced. That includes tolerance testing against '
              + (sc.loan_estimates_read === 1 ? 'your Loan Estimate' : 'all ' + sc.loan_estimates_read + ' Loan Estimates')
              + ' — we checked whether any fee rose beyond what the lending rules permit, and none did. '
              // A customer who supplied a contract too was told only about
              // tolerance testing. They handed over a third document and got no
              // acknowledgement it was used, which reads as though it was ignored.
              + (sc.contract_reconciled
                  ? 'It also includes your purchase contract — we checked the credits and concessions '
                    + 'the seller agreed to against what the Closing Disclosure actually shows. '
                  : '')
              + 'The full audit shows you every charge we examined and what we measured it against.</p>'
            : '<p class="scorecard-note">No issues surfaced from the Closing Disclosure alone. '
          + 'The full audit shows every check we ran and what each one was measured against. '
          // Offered "Add your Loan Estimate or purchase contract" regardless of
          // what had already been supplied, so a customer who uploaded a contract
          // was told to upload a contract. The same mistake the coverage panel was
          // fixed for; this sentence was written separately and missed.
          + (function () {
              var wants = [];
              if (!sc.loan_estimates_uploaded) wants.push('your Loan Estimate');
              if (!isRefi && !sc.contract_uploaded) wants.push('your purchase contract');
              if (!wants.length) return '';
              var gains = [];
              if (!sc.loan_estimates_uploaded) gains.push('tolerance testing');
              if (!isRefi && !sc.contract_uploaded) gains.push('credit reconciliation');
              return 'Add ' + wants.join(' or ') + ' and it also runs ' + gains.join(' and ')
                + ', which is where most recoverable money turns up.';
            }())
          + '</p>');

      panel.innerHTML = html;

      // The provider question is asked before the scorecard now, so nothing here
      // shows or hides it. hasLE is still needed below for the upgrade prompt.
      const hasLE = Boolean(sc.loan_estimates_uploaded || (sc.tier && sc.tier.has_loan_estimate));
      const intro = document.getElementById('q-intro');
      if (intro) {
        intro.innerHTML = hasLE
          ? '<strong>One more question.</strong> It decides which tolerance rule applies to Section C \u2014 about 15 seconds.'
          : '';
      }

      // Adding a Loan Estimate starts a new submission, so anything already
      // answered would otherwise be asked a second time. Restore it instead.
      // No-op on the standalone scorecard page, which has no question fields
      // to repopulate.
      if (typeof restoreAnswers === 'function') restoreAnswers();

      // Both the "Replace those documents" and "Add those documents" buttons
      // carried id="add-docs-btn". getElementById returns the first match only,
      // so the lower button -- the one attached to the upsell panel, the one a
      // customer reaches after reading what they would gain -- did nothing at
      // all when clicked. A class and querySelectorAll wires every one of them.
      const addDocs = document.querySelectorAll('.js-add-docs');
      for (let i = 0; i < addDocs.length; i += 1) {
        addDocs[i].addEventListener('click', function(ev){ ev.preventDefault(); showUploader(); });
      }
    }

    return {
      renderScorecard: renderScorecard,
      applyTier: applyTier,
      money: money,
      unreadableCount: function () { return unreadableRemaining; },
      hasAcknowledged: function () { return acknowledgedGaps; },
      acknowledge: function () { acknowledgedGaps = true; },
    };
  }

  global.createScorecardView = createScorecardView;

})(window);
