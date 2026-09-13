// Runs navigator-status.html's HOA renderer against a real report shape.
//
// The same reason tests/scorecard-view.test.js exists: a renderer that throws
// leaves the page blank with a clean CI run. `escH is not a function` parsed
// perfectly and still blanked a page. Parsing proves nothing; running does.
//
// This matters more than usual for the restrictions block, because it is brand
// new and because it is the half of the HOA report a buyer's attorney would
// read first. A block that silently fails to render is indistinguishable, from
// the customer's side, from the engine never having looked.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// --- a DOM small enough to read and real enough to assert on ----------------

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    style: {},
    className: '',
    id: '',
    hidden: false,
    _text: '',
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child) { this.children.push(child); return child; },
    remove() {},
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    scrollIntoView() {},
    focus() {},
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join(' ');
    },
    set textContent(v) { this._text = String(v == null ? '' : v); this.children = []; },
    get innerHTML() { return this.textContent; },
    set innerHTML(v) { this._text = ''; this.children = []; if (v) this._text = String(v); },
    get parentNode() { return this._parent || null; },
  };
  // appendChild has to record parentage for renderScoreBasis, which walks up
  // from the summary paragraph to insert beside it.
  const append = el.appendChild.bind(el);
  el.appendChild = (child) => { if (child) child._parent = el; return append(child); };
  const insert = el.insertBefore.bind(el);
  el.insertBefore = (child) => { if (child) child._parent = el; return insert(child); };
  return el;
}

// Every element in the page's markup that carries a `hidden` attribute. The
// stub has to start these hidden or a test asserting "this block stays hidden"
// passes for the wrong reason.
const HIDDEN_IN_MARKUP = new Set([
  'report-view', 'numbers-block', 'hoa-risk-block', 'hoa-findings-block',
  'hoa-restrictions-block', 'uncertain-block', 'closing-block', 'fixups-block',
  'report-tag', 'hoa-progress',
]);

function makeDocument() {
  const byId = {};
  return {
    byId,
    getElementById(id) {
      if (!byId[id]) {
        const el = makeEl('div');
        el.id = id;
        el.hidden = HIDDEN_IN_MARKUP.has(id);
        // Real elements sit inside a parent. renderScoreBasis inserts beside
        // the summary paragraph, so a parentless stub would silently skip it.
        const parent = makeEl('div');
        parent.appendChild(el);
        byId[id] = el;
      }
      return byId[id];
    },
    createElement: (tag) => makeEl(tag),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    body: makeEl('body'),
  };
}

// --- load the page's inline script ------------------------------------------
//
// The script is one IIFE. Strip the wrapper and hand back the functions under
// test; everything else in it runs as it normally would, which is the point —
// a bootstrap that throws would take the renderer down with it in production
// too.
function loadRenderer(doc) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'navigator-status.html'), 'utf8');
  const blocks = src.match(/<script>([\s\S]*?)<\/script>/g) || [];
  const inline = blocks
    .map((b) => b.replace(/<\/?script[^>]*>/g, ''))
    .filter((b) => b.includes('renderHoaExtras'))[0];
  assert.ok(inline, 'could not find the inline script that defines renderHoaExtras');

  const body = inline
    .replace(/^\s*\(function\(\)\{/, '')
    .replace(/\}\)\(\);?\s*$/, '');

  // Exported at the TOP, not the bottom. The page's bootstrap returns early
  // when there is no submission in the URL or in storage — which is exactly
  // the state this test runs in — so an export appended after it never runs.
  // Function declarations hoist, so they are already bound here.
  const factory = new Function(
    '__exports',
    'window', 'document', 'location', 'localStorage', 'sessionStorage',
    'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', 'fetch',
    'navigator', 'console', 'pollNavigatorSubmission', 'getStoredSubmission',
    'showToast', 'storeSubmission', 'URLSearchParams', 'alert',
    '__exports.renderHoaExtras = renderHoaExtras;\n' + body
  );
  const exported = {};

  const noop = () => {};
  const store = { getItem: () => null, setItem: noop, removeItem: noop };
  factory(
    exported,
    { addEventListener: noop, location: { href: '', search: '' } },
    doc,
    { href: 'http://localhost/navigator-status', search: '' },
    store, store,
    () => 0, () => 0, noop, noop,
    () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    { userAgent: 'test', clipboard: { writeText: () => Promise.resolve() } },
    { log: noop, warn: noop, error: noop },
    () => Promise.resolve(null),
    () => null,
    noop, noop, URLSearchParams, noop
  );

  assert.equal(typeof exported.renderHoaExtras, 'function',
    'the page no longer defines renderHoaExtras as a hoisted declaration');
  return exported;
}

// --- a report in the shape the engine now produces --------------------------

function hoaReport(overrides = {}) {
  return Object.assign({
    risk_score: 'High',
    risk_score_basis: 'Scored High because reserves are 23% funded, in the band widely treated as weak.',
    risk_score_computed: true,
    headline: 'Reserves are thin against a roof due in two years',
    headline_tag: 'High risk',
    summary: 'The association is 23% funded.',
    short_term_risk: { likelihood: 'Possible', rationale: 'Nothing announced yet.', estimated_per_unit_low: '', estimated_per_unit_high: '', basis: '', citations: [] },
    mid_term_risk: { likelihood: 'Likely', rationale: 'The roof is due in 2028.', estimated_per_unit_low: '$3,167', estimated_per_unit_high: '$4,767', basis: 'Gap over 120 units.', citations: [] },
    reserve_health: { percent_funded: '23%', reserve_balance: '$412,000', fully_funded_balance: '$1,830,000', annual_contribution: '$84,000', recommended_contribution: '$198,000', assessment: '', citations: [] },
    findings: [
      { concern: 'Reserves are 23% funded', severity: 'High', detail: 'Against a fully funded balance of $1,830,000.', pinpoint: '', citations: [{ document_title: 'Reserve Study', start_page: 4, end_page: 4, cited_text: 'Percent funded: 22.5%' }] },
    ],
    restrictions: {
      leasing: {
        restricted: 'Restricted',
        cap: '25% of units',
        current_status: 'Cap is full; waitlist of 9 owners, about four years',
        minimum_lease_term: '12 months',
        owner_occupancy_requirement: 'One year after purchase',
        short_term_rentals: 'Prohibited',
        detail: 'You could not rent this unit out on purchase, and the waitlist is long.',
        citations: [{ document_title: 'Bylaws', start_page: 14, end_page: 14, cited_text: 'No more than 25% of units may be leased.' }],
      },
      fees_at_closing: [
        { label: 'Capital contribution', amount: '$1,200', payer: 'Buyer', citations: [] },
        { label: 'Transfer fee', amount: '$350', payer: 'Buyer', citations: [] },
      ],
      use_restrictions: [
        { topic: 'Pets', rule: 'Two pets, under 40lb each', citations: [] },
        { topic: 'Parking', rule: 'One assigned space; no commercial vehicles', citations: [] },
      ],
      financeability: {
        concerns: ['Investor concentration at 31%'],
        fha_va_status: 'Not stated in the documents provided',
        detail: 'Investor concentration above 25% can limit conventional financing.',
        citations: [],
      },
    },
    key_numbers: [],
    sections: [],
    missing_or_uncertain: [],
  }, overrides);
}

// --- the tests --------------------------------------------------------------

test('the HOA renderer runs without throwing on a full report', () => {
  const doc = makeDocument();
  const { renderHoaExtras } = loadRenderer(doc);
  renderHoaExtras(hoaReport());
  assert.equal(doc.getElementById('hoa-restrictions-block').hidden, false);
});

test('the leasing restriction is rendered, including the cap and the waitlist', () => {
  const doc = makeDocument();
  loadRenderer(doc).renderHoaExtras(hoaReport());

  const text = doc.getElementById('hoa-restrictions').textContent;
  assert.match(text, /Renting the unit out/);
  assert.match(text, /25% of units/);
  assert.match(text, /waitlist of 9 owners/i);
  assert.match(text, /12 months/);
  assert.match(text, /Prohibited/);
});

test('money due at closing is rendered with its amounts', () => {
  const doc = makeDocument();
  loadRenderer(doc).renderHoaExtras(hoaReport());

  const text = doc.getElementById('hoa-restrictions').textContent;
  assert.match(text, /Due at closing/);
  assert.match(text, /Capital contribution/);
  assert.match(text, /\$1,200/);
  assert.match(text, /\$350/);
});

test('use restrictions and financeability are rendered', () => {
  const doc = makeDocument();
  loadRenderer(doc).renderHoaExtras(hoaReport());

  const text = doc.getElementById('hoa-restrictions').textContent;
  assert.match(text, /Pets/);
  assert.match(text, /under 40lb/);
  assert.match(text, /Investor concentration at 31%/);
  assert.match(text, /Financing and resale/);
});

test('the score basis is shown, so the reader can check the score', () => {
  const doc = makeDocument();
  loadRenderer(doc).renderHoaExtras(hoaReport());

  const summary = doc.getElementById('report-summary');
  const rendered = (summary.parentNode ? summary.parentNode.children : [])
    .map((c) => c.textContent).join(' ');
  assert.match(rendered, /How this score was reached/);
  assert.match(rendered, /23% funded/);
});

test('a score that could not be computed says so without the "how this was reached" framing', () => {
  const doc = makeDocument();
  loadRenderer(doc).renderHoaExtras(hoaReport({
    risk_score_computed: false,
    risk_score_basis: 'The documents provided do not establish the reserve position.',
  }));

  const summary = doc.getElementById('report-summary');
  const rendered = (summary.parentNode ? summary.parentNode.children : [])
    .map((c) => c.textContent).join(' ');
  assert.match(rendered, /do not establish/);
  assert.ok(!/How this score was reached/.test(rendered));
});

test('a report with no restrictions block leaves the section hidden', () => {
  const doc = makeDocument();
  const report = hoaReport();
  delete report.restrictions;
  loadRenderer(doc).renderHoaExtras(report);
  assert.equal(doc.getElementById('hoa-restrictions-block').hidden, true);
});

test('an empty restrictions block — nothing found in the documents — stays hidden rather than rendering empty cards', () => {
  const doc = makeDocument();
  loadRenderer(doc).renderHoaExtras(hoaReport({
    restrictions: {
      leasing: { restricted: '', cap: '', current_status: '', minimum_lease_term: '', owner_occupancy_requirement: '', short_term_rentals: '', detail: '', citations: [] },
      fees_at_closing: [],
      use_restrictions: [],
      financeability: { concerns: [], fha_va_status: '', detail: '', citations: [] },
    },
  }));
  assert.equal(doc.getElementById('hoa-restrictions-block').hidden, true);
});

test('"Not addressed in the documents provided" still renders — an absence the buyer must know about', () => {
  const doc = makeDocument();
  loadRenderer(doc).renderHoaExtras(hoaReport({
    restrictions: {
      leasing: {
        restricted: 'Not addressed in the documents provided',
        cap: '', current_status: '', minimum_lease_term: '', owner_occupancy_requirement: '', short_term_rentals: '',
        detail: 'The bylaws were not provided, so leasing restrictions could not be checked.',
        citations: [],
      },
      fees_at_closing: [],
      use_restrictions: [],
      financeability: { concerns: [], fha_va_status: '', detail: '', citations: [] },
    },
  }));

  const text = doc.getElementById('hoa-restrictions').textContent;
  assert.match(text, /Not addressed in the documents provided/);
  assert.match(text, /bylaws were not provided/);
});
