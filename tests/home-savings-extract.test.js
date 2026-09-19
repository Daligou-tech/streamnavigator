// Home Savings bill extraction — the classifier and the merge.
//
// Both are pure, so this suite runs entirely offline and spends nothing. The
// only part that touches the network is the API call, which is exercised here
// through an injected fetch.
//
// The assertions that matter most are the exclusions. A classifier that calls
// "Broadcast TV Fee" an optional add-on sends a customer to argue on the phone
// for something they cannot have, and they come back knowing the report was
// guessing. Those cases are the reason classification is a table and not the
// model's judgement.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const X = require('../api/_lib/home-savings-extract');
const ENGINE = require('../navigator-home-savings-engine');

const C = X.Category;
const cls = (label, amount) => X.classifyLine(label, amount);

/* ------------------------------------------------------------- classifier */

test('equipment rentals are recognised across providers', () => {
  for (const label of [
    'Equipment Rental - Gateway', 'Wireless Gateway', 'Modem Rental', 'Router rental fee',
    'HD Receiver', 'Cable Box', 'Set-Top Box', 'xFi Complete', 'DVR Service',
    'Monitoring Panel',
  ]) {
    assert.equal(cls(label, 15), C.EQUIPMENT, `"${label}" should be equipment`);
  }
});

test('EXCLUSION: mandatory and pass-through charges are never add-on candidates', () => {
  // Every one of these reads like something optional. None is.
  for (const label of [
    'Broadcast TV Fee', 'Regional Sports Fee', 'FCC Regulatory Fee', 'State Tax',
    'E911 Surcharge', 'Universal Service Fund', 'Franchise Fee', 'Gross Receipts Tax',
    'Cost Recovery Charge', 'Late Fee', 'Delivery Service Charge', 'Distribution Charge',
    'Basic Service Charge',
  ]) {
    assert.equal(cls(label, 8), C.TAX_OR_FEE,
      `"${label}" is mandatory — calling it an add-on sends the customer to lose an argument`);
  }
});

test('EXCLUSION: a credit is never a charge to stop', () => {
  for (const label of ['Equipment Return Credit', 'Loyalty Credit', 'Billing Adjustment', 'Rebate']) {
    const c = cls(label, -10);
    assert.ok([C.CREDIT, C.AUTOPAY_DISCOUNT, C.PROMO_DISCOUNT].includes(c),
      `"${label}" is money in the customer's favour, got ${c}`);
  }
  // "Equipment Return Credit" contains "equipment" and must not be read as a
  // rental to cancel.
  assert.notEqual(cls('Equipment Return Credit', -10), C.EQUIPMENT);
});

test('a negative amount is a credit whatever the label says', () => {
  assert.equal(cls('Gateway', -15), C.CREDIT);
  assert.equal(cls('Autopay', -10), C.AUTOPAY_DISCOUNT);
  assert.equal(cls('Promotional rate', -25), C.PROMO_DISCOUNT);
});

test('instalments, add-ons and base service are told apart', () => {
  assert.equal(cls('Device Payment 24 of 24', 27.08), C.INSTALMENT);
  assert.equal(cls('Equipment Installment Plan', 22), C.INSTALMENT);
  assert.equal(cls('Inside Wire Maintenance', 5.99), C.ADDON);
  assert.equal(cls('Device Protection', 17), C.ADDON);
  assert.equal(cls('HBO Max', 15.99), C.ADDON);
  assert.equal(cls('Roadside Assistance', 8), C.ADDON);
  assert.equal(cls('Unlimited Plan', 70), C.BASE_SERVICE);
  assert.equal(cls('Bodily Injury Liability', 210), C.BASE_SERVICE);
  assert.equal(cls('Energy Charge', 62), C.BASE_SERVICE);
});

test('an unrecognised label is unknown, not guessed into a category', () => {
  assert.equal(cls('Zephyr Tier Alpha', 12), C.UNKNOWN);
  assert.equal(cls('', 12), C.UNKNOWN);
});

/* ------------------------------------------------------- the confidence gate */

test('a low-confidence line is discarded rather than used', () => {
  const typed = [{ kind: 'internet', provider: 'Xfinity', monthly: 89 }];
  const shaky = X.normalizeExtraction({
    bills: [{
      provider: 'Xfinity', service_hint: 'Internet',
      line_items: [{ label: 'Equipment Rental', amount: 15, monthly: true, confidence: 0.6 }],
    }],
  });
  const merged = X.merge(typed, shaky);
  assert.notEqual(merged.bills[0].equipmentRental, true,
    'a reading below 0.85 must not become a finding');

  const solid = X.normalizeExtraction({
    bills: [{
      provider: 'Xfinity', service_hint: 'Internet',
      line_items: [{ label: 'Equipment Rental', amount: 15, monthly: true, confidence: 0.95 }],
    }],
  });
  assert.equal(X.merge(typed, solid).bills[0].equipmentRental, true);
});

test('a one-off charge is not treated as a recurring one', () => {
  const ex = X.normalizeExtraction({
    bills: [{
      provider: 'Xfinity', service_hint: 'Internet',
      line_items: [{ label: 'Equipment Rental', amount: 15, monthly: false, confidence: 0.98 }],
    }],
  });
  const merged = X.merge([{ kind: 'internet', provider: 'Xfinity', monthly: 89 }], ex);
  assert.notEqual(merged.bills[0].equipmentRental, true,
    'a one-off charge must not be annualised into a saving');
});

/* -------------------------------------------------------------- the merge */

const XFINITY = {
  bills: [{
    provider: 'Xfinity',
    service_hint: 'Internet',
    total_due: { value: 89, confidence: 0.98 },
    promo_end_date: { value: '2026-12-01', confidence: 0.93 },
    standard_rate_after_promo: { value: 104, confidence: 0.9 },
    line_items: [
      { label: 'Performance Pro 400', amount: 62, monthly: true, confidence: 0.98 },
      { label: 'Equipment Rental - Gateway', amount: 15, monthly: true, confidence: 0.97 },
      { label: 'Inside Wire Maintenance', amount: 5.99, monthly: true, confidence: 0.96 },
      { label: 'Broadcast TV Fee', amount: 6.01, monthly: true, confidence: 0.99 },
    ],
  }],
};

test('a printed amount beats a remembered one, and the disagreement is recorded', () => {
  const typed = [{ kind: 'internet', provider: 'Xfinity', monthly: 75, equipmentRental: false }];
  const m = X.merge(typed, X.normalizeExtraction(XFINITY));

  assert.equal(m.bills[0].monthly, 89, 'the statement is right about the total');
  assert.equal(m.bills[0].equipmentRental, true, 'and right about the equipment');
  assert.equal(m.bills[0].equipmentFee, 15);

  const fields = m.disagreements.map((d) => d.field).sort();
  assert.deepEqual(fields, ['equipmentRental', 'monthly']);
  assert.match(m.disagreements.find((d) => d.field === 'equipmentRental').billSays,
    /Equipment Rental - Gateway/);
});

test('an add-on found on the bill becomes a question, never a finding', () => {
  const typed = [{ kind: 'internet', provider: 'Xfinity', monthly: 89 }];
  const m = X.merge(typed, X.normalizeExtraction(XFINITY));

  // Wire maintenance is on the statement. Whether they WANT it is not.
  const q = m.newQuestions.find((n) => /Wire Maintenance/i.test(n.label));
  assert.ok(q, 'the unmentioned add-on must be surfaced');
  assert.equal(q.checkId, 'H4');
  assert.match(q.question, /Do you use it\?$/);

  const a = ENGINE.analyze({ bills: m.bills }, { openQuestions: m.newQuestions });
  const addonFinding = a.findings.find((f) => f.checkId === 'H4');
  assert.equal(addonFinding, undefined,
    'an add-on on the statement is not an add-on the customer wants rid of');
  assert.equal(a.totals.confirmedAnnual, 180, 'only the equipment rental counts');
});

test('the mandatory fee on the same bill never becomes a question either', () => {
  const m = X.merge([{ kind: 'internet', provider: 'Xfinity', monthly: 89 }],
    X.normalizeExtraction(XFINITY));
  assert.ok(!m.newQuestions.some((q) => /Broadcast TV/i.test(q.label)),
    'Broadcast TV Fee is mandatory and must never be raised as droppable');
});

test('an add-on the customer DID name is repriced from the bill', () => {
  const typed = [{
    kind: 'internet', provider: 'Xfinity', monthly: 89,
    addOns: [{ label: 'wire maintenance', monthly: 3 }],
  }];
  const m = X.merge(typed, X.normalizeExtraction(XFINITY));
  assert.equal(m.bills[0].addOns[0].monthly, 5.99, 'the bill knows better than memory');
  assert.equal(m.bills[0].addOns[0].label, 'Inside Wire Maintenance');

  const a = ENGINE.analyze({ bills: m.bills });
  const f = a.findings.find((x) => x.checkId === 'H4');
  assert.equal(f.amount, 71.88);
  assert.match(f.basis, /Read from your statement/);
});

test('reading the bill lets a check run and PASS instead of sitting unanswered', () => {
  const typed = [{ kind: 'internet', provider: 'Xfinity', monthly: 89 }];
  const noEquip = X.normalizeExtraction({
    bills: [{
      provider: 'Xfinity', service_hint: 'Internet',
      total_due: { value: 89, confidence: 0.98 },
      line_items: [{ label: 'Performance Pro 400', amount: 89, monthly: true, confidence: 0.98 }],
    }],
  });
  const before = ENGINE.analyze({ bills: typed });
  assert.ok(before.couldNotRun.some((c) => c.checkId === 'H1'));

  const m = X.merge(typed, noEquip);
  const after = ENGINE.analyze({ bills: m.bills });
  assert.ok(!after.couldNotRun.some((c) => c.checkId === 'H1'),
    'we read the statement and there is no equipment line — that is an answer');
  assert.equal(m.bills[0].equipmentRental, false);
});

test('"24 of 24" settles paid-off without the customer remembering', () => {
  const m = X.merge([{ kind: 'mobile', provider: 'Verizon', monthly: 120 }],
    X.normalizeExtraction({
      bills: [{
        provider: 'Verizon', service_hint: 'Wireless',
        total_due: { value: 120, confidence: 0.98 },
        instalment_payments_made: { made: 24, total: 24, confidence: 0.94 },
        line_items: [
          { label: 'Unlimited Plan', amount: 70, monthly: true, confidence: 0.98 },
          { label: 'Device Payment Agreement', amount: 27.08, monthly: true, confidence: 0.97 },
        ],
      }],
    }));
  assert.equal(m.bills[0].deviceInstalment, true);
  assert.equal(m.bills[0].devicePaidOff, true);

  const a = ENGINE.analyze({ bills: m.bills });
  const f = a.findings.find((x) => x.checkId === 'H3');
  assert.equal(f.kind, 'confirmed');
  assert.equal(f.amount, 324.96);
  assert.match(f.basis, /Read from your statement/);
});

test('an incomplete instalment agreement is NOT called paid off', () => {
  const m = X.merge([{ kind: 'mobile', provider: 'Verizon', monthly: 120 }],
    X.normalizeExtraction({
      bills: [{
        provider: 'Verizon', service_hint: 'Wireless',
        instalment_payments_made: { made: 18, total: 24, confidence: 0.94 },
        line_items: [{ label: 'Device Payment Agreement', amount: 27.08, monthly: true, confidence: 0.97 }],
      }],
    }));
  assert.equal(m.bills[0].deviceInstalment, true);
  assert.notEqual(m.bills[0].devicePaidOff, true);
  assert.equal(ENGINE.analyze({ bills: m.bills }).findings.filter((f) => f.checkId === 'H3').length, 0);
});

test('a bill in the upload the customer never named is picked up', () => {
  const m = X.merge([{ kind: 'internet', provider: 'Xfinity', monthly: 89 }],
    X.normalizeExtraction({
      bills: [
        XFINITY.bills[0],
        {
          provider: 'ADT', service_hint: 'Security Monitoring',
          total_due: { value: 52, confidence: 0.95 },
          line_items: [
            { label: 'Monitoring Panel', amount: 12, monthly: true, confidence: 0.95 },
            { label: 'Monitoring Service', amount: 40, monthly: true, confidence: 0.95 },
          ],
        },
      ],
    }));
  assert.equal(m.bills.length, 2);
  const adt = m.bills.find((b) => b.provider === 'ADT');
  assert.equal(adt.kind, 'security');
  assert.equal(adt.discoveredInUpload, true);
  assert.equal(adt.equipmentRental, true, 'and its rented panel is found');
  assert.deepEqual(m.foundBills.map((b) => b.provider), ['ADT']);
});

test('a month-on-month jump is a question, never check H7', () => {
  // H7 is year-on-year. A statement prints LAST MONTH, and conflating the two
  // would put a January heating bill into a report as a price rise.
  const m = X.merge([{ kind: 'internet', provider: 'Xfinity', monthly: 89 }],
    X.normalizeExtraction({
      bills: [{
        provider: 'Xfinity', service_hint: 'Internet',
        total_due: { value: 89, confidence: 0.98 },
        prior_period_amount: { value: 74, confidence: 0.95 },
        line_items: [{ label: 'Performance Pro 400', amount: 89, monthly: true, confidence: 0.98 }],
      }],
    }));
  assert.equal(m.bills[0].lastYearMonthly, undefined, 'never fed into H7');
  const q = m.newQuestions.find((n) => n.checkId === 'H7');
  assert.ok(q);
  assert.match(q.question, /not a year-on-year comparison/);

  const a = ENGINE.analyze({ bills: m.bills }, { openQuestions: m.newQuestions });
  assert.equal(a.totals.increaseAnnual, 0, 'and never counted');
});

test('a usage-driven bill gets no month-on-month question at all', () => {
  const m = X.merge([{ kind: 'electric', provider: 'ConEd', monthly: 210 }],
    X.normalizeExtraction({
      bills: [{
        provider: 'ConEd', service_hint: 'Electric Service',
        total_due: { value: 210, confidence: 0.98 },
        prior_period_amount: { value: 90, confidence: 0.95 },
        line_items: [{ label: 'Energy Charge', amount: 210, monthly: true, confidence: 0.98 }],
      }],
    }));
  assert.equal(m.newQuestions.length, 0,
    'a heating bill doubling between months is weather, not a price rise');
});

/* ------------------------------------------------------------- the schema */

test('every confidence score in the schema is required', () => {
  // Same contract as tests/extraction-schema.test.js: an optional confidence
  // field is a silent off switch, because confident() is false when the score
  // is ABSENT, not merely low.
  const offenders = [];
  (function walk(node, path) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' && node.properties) {
      if (Object.prototype.hasOwnProperty.call(node.properties, 'confidence')) {
        const req = Array.isArray(node.required) ? node.required : [];
        if (req.indexOf('confidence') === -1) offenders.push(path || '(root)');
      }
      for (const [k, child] of Object.entries(node.properties)) {
        walk(child, path ? `${path}.${k}` : k);
      }
    }
    if (node.type === 'array' && node.items) walk(node.items, `${path}[]`);
  }(X.EXTRACT_TOOL.input_schema, ''));
  assert.deepEqual(offenders, []);
});

test('the extraction prompt forbids classifying and judging', () => {
  assert.match(X.EXTRACT_SYSTEM, /Never classify/);
  assert.match(X.EXTRACT_SYSTEM, /Never judge/);
  assert.match(X.EXTRACT_SYSTEM, /Never infer a value that is not printed/);
  assert.match(X.EXTRACT_SYSTEM, /Include taxes, surcharges/,
    'filtering at transcription time would hide the lines the classifier needs to exclude');
});

/* ---------------------------------------------------------- the API call */

function fakeFetch(payload, opts) {
  const o = opts || {};
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return {
      ok: o.ok !== false,
      status: o.status || 200,
      text: async () => 'error body',
      json: async () => (typeof payload === 'function' ? payload(calls) : payload),
    };
  };
  fn.calls = () => calls;
  return fn;
}

const TOOL_USE = {
  stop_reason: 'tool_use',
  content: [{
    type: 'tool_use',
    name: 'record_household_bills',
    input: XFINITY,
  }],
};

test('a successful extraction is normalized and classified', async () => {
  const f = fakeFetch(TOOL_USE);
  const out = await X.extractHouseholdBills('key', [{ type: 'text', text: 'x' }], { fetch: f });
  assert.equal(out.bills.length, 1);
  const cats = out.bills[0].lineItems.map((li) => li.category);
  // "Performance Pro 400" is a plan name with no recognisable word in it, so
  // it lands in UNKNOWN. That is the correct failure direction: an
  // unrecognised line is never actionable, and the two that matter beside it
  // are still told apart.
  assert.deepEqual(cats, [C.UNKNOWN, C.EQUIPMENT, C.ADDON, C.TAX_OR_FEE]);
});

test('a truncated tool call is retried, not used', async () => {
  const f = fakeFetch((n) => (n === 1 ? { stop_reason: 'max_tokens', content: [] } : TOOL_USE));
  const out = await X.extractHouseholdBills('key', [], { fetch: f });
  assert.equal(f.calls(), 2);
  assert.equal(out.bills.length, 1);
});

test('two truncated attempts throw rather than returning half a bill', async () => {
  const f = fakeFetch({ stop_reason: 'max_tokens', content: [] });
  await assert.rejects(() => X.extractHouseholdBills('key', [], { fetch: f }),
    /truncated/);
  assert.equal(f.calls(), 2);
});

test('an API error is thrown, not swallowed into an empty reading', async () => {
  const f = fakeFetch({}, { ok: false, status: 529 });
  await assert.rejects(() => X.extractHouseholdBills('key', [], { fetch: f }), /529/);
});

test('the engine falls back to the typed answers when extraction fails', () => {
  // The contract the generation path relies on: a failed read costs the report
  // its document half and nothing else.
  const typed = [{ kind: 'internet', provider: 'Xfinity', monthly: 89, equipmentRental: true, equipmentFee: 15 }];
  const a = ENGINE.analyze({ bills: typed });
  assert.equal(a.totals.confirmedAnnual, 180);
  assert.doesNotMatch(a.findings[0].basis, /Read from your statement/,
    'and it must not claim a statement was read');
});
