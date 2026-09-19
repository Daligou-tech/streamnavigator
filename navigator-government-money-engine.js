/* =========================================================================
   navigator-government-money-engine.js — the pre-payment gate for
   Government Money Finder.

   This is deliberately NOT yet the deterministic decision engine the other
   products have. docs/GOVERNMENT-MONEY-AUDIT.md §22 specifies that engine —
   a gated program catalogue, a DON'T-COUNT pass that can only ever remove a
   figure, and a time pass that produces dated NOT-NOW lines — and §26 puts it
   in Fix Next, because it needs data/government-programs.json to exist first.

   What ships here is the one thing that could not wait: the gate.

   The audit verified, live on 2026-09-19, that a description of a single
   character ("x") created a submission and handed the browser to a $39 Stripe
   checkout. government-money fell through the generic `else` in
   api/navigator-intake.js, which asks only that the description be non-empty.
   /buying, /subscriptions, /home-savings and /landlord each got a structured
   gate; this product never did.

   And the field it needs most was not collected in any form. Every rebate,
   credit or grant that is not federal is scoped to a place — a state, a
   county, a utility territory. A customer who does not say where they live
   has bought a report that can only discuss federal programs and then say so.
   That is the report arriving empty-handed for a reason discoverable before
   payment, which is the D-04 defect this repository has now closed four
   times.

   So: one rule, enforced in one file, loaded by both government-money.html
   and api/navigator-intake.js — so the check that lets a customer pay and the
   check the server enforces cannot drift. A file upload does NOT satisfy it:
   a receipt may well carry an address, but nothing reads the bytes before
   payment, so accepting one here would be trusting a document nobody has
   opened.

   Everything else the report needs — tenure, household size, income band,
   federal tax liability, what was installed and when — is asked for in prose
   on the page today and becomes structured fields in Fix Next. Those are not
   gated yet on purpose: a gate nobody can pass is worse than a thin report,
   and free text cannot be parsed for them honestly.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GovernmentMoneyEngine = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Names and postal codes for the fifty states, DC and the five inhabited
  // territories. Territories are included because their residents are
  // eligible for federal programs and for their own local ones, and being
  // told "name your state" by a form that does not know Guam exists is its
  // own kind of insult.
  const PLACES = [
    ['Alabama', 'AL'], ['Alaska', 'AK'], ['Arizona', 'AZ'], ['Arkansas', 'AR'],
    ['California', 'CA'], ['Colorado', 'CO'], ['Connecticut', 'CT'], ['Delaware', 'DE'],
    ['Florida', 'FL'], ['Georgia', 'GA'], ['Hawaii', 'HI'], ['Idaho', 'ID'],
    ['Illinois', 'IL'], ['Indiana', 'IN'], ['Iowa', 'IA'], ['Kansas', 'KS'],
    ['Kentucky', 'KY'], ['Louisiana', 'LA'], ['Maine', 'ME'], ['Maryland', 'MD'],
    ['Massachusetts', 'MA'], ['Michigan', 'MI'], ['Minnesota', 'MN'], ['Mississippi', 'MS'],
    ['Missouri', 'MO'], ['Montana', 'MT'], ['Nebraska', 'NE'], ['Nevada', 'NV'],
    ['New Hampshire', 'NH'], ['New Jersey', 'NJ'], ['New Mexico', 'NM'], ['New York', 'NY'],
    ['North Carolina', 'NC'], ['North Dakota', 'ND'], ['Ohio', 'OH'], ['Oklahoma', 'OK'],
    ['Oregon', 'OR'], ['Pennsylvania', 'PA'], ['Rhode Island', 'RI'], ['South Carolina', 'SC'],
    ['South Dakota', 'SD'], ['Tennessee', 'TN'], ['Texas', 'TX'], ['Utah', 'UT'],
    ['Vermont', 'VT'], ['Virginia', 'VA'], ['Washington', 'WA'], ['West Virginia', 'WV'],
    ['Wisconsin', 'WI'], ['Wyoming', 'WY'],
    ['District of Columbia', 'DC'],
    ['Puerto Rico', 'PR'], ['Guam', 'GU'], ['American Samoa', 'AS'],
    ['U.S. Virgin Islands', 'VI'], ['Northern Mariana Islands', 'MP'],
  ];

  // Full names are matched case-insensitively; postal codes are matched
  // UPPERCASE ONLY, and that asymmetry is the whole trick.
  //
  // Half the codes are ordinary English words — IN, OR, ME, OK, HI, DE, MS,
  // PA, AL, AR, CA, LA, MA, MD, MT, NE, MI, MO, SC, VA, WA. A
  // case-insensitive match on those passes every sentence ever written, which
  // is a gate that is not a gate. Requiring the capital letters a person
  // actually types when they mean a state costs nothing — anyone writing
  // "Ohio" is matched by the name, and anyone writing "OH" meant the state.
  //
  // The residual false positive is a description typed in caps throughout,
  // which is accepted when it should not be. That direction is the cheap one:
  // wrongly accepting costs a thinner report, wrongly rejecting costs a
  // customer who cannot buy at all.
  const NAME_RE = new RegExp(
    '\\b(' + PLACES.map((p) => p[0].replace(/\./g, '\\.')).join('|') + ')\\b', 'i',
  );
  const CODE_RE = new RegExp('\\b(' + PLACES.map((p) => p[1]).join('|') + ')\\b');

  // "Washington DC" must not be read as the state of Washington, and it does
  // not matter here — both are places we accept — but a ZIP is a stronger
  // signal than either and people type one instead of a state name often
  // enough to be worth accepting on its own.
  const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;

  /** Does this free text say where the customer is? */
  function namesAPlace(text) {
    const s = String(text || '');
    return NAME_RE.test(s) || CODE_RE.test(s) || ZIP_RE.test(s);
  }

  /**
   * The gate. Same rules the page gates its button on and the server enforces,
   * because both load this file.
   *
   * @param {{description?: string}} formData
   * @returns {{sufficient: boolean, missing: string[], message: string|null}}
   */
  function checkSufficiency(formData) {
    const description = typeof (formData || {}).description === 'string'
      ? formData.description.trim() : '';

    if (!description) {
      return {
        sufficient: false,
        missing: ['description'],
        message: 'Tell us about your situation — at minimum, which state you live in. '
          + 'Every program that is not federal is scoped to a place, so without it '
          + 'there is nothing local to check.',
      };
    }

    if (!namesAPlace(description)) {
      return {
        sufficient: false,
        missing: ['state'],
        message: 'Add your state (or ZIP code). Federal programs are the same everywhere, '
          + 'but state, county and utility programs are not — and those are most of them. '
          + 'Without a place to work from, the report can only cover the federal side.',
      };
    }

    return { sufficient: true, missing: [], message: null };
  }

  return { PLACES, namesAPlace, checkSufficiency };
}));
