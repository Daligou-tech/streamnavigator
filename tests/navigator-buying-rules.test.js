// Unit tests for the pre-payment sufficiency gate's rules — the actual
// definition of "enough information" shared by buying.html and
// api/navigator-intake.js. These are the cases from the QA finding this
// whole change responds to: "fridge purchase 33 inch" (and its cousin,
// "purchasing a new 33 inch bridge") must never come back sufficient, while
// a properly filled-out submission for any category must.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CATEGORIES,
  fieldsForCategory,
  checkBuyingSufficiency,
  buildReadySummary,
  PROMISED_OUTPUTS,
} = require('../navigator-buying-rules');

test('no category selected is always insufficient, regardless of other fields', () => {
  const result = checkBuyingSufficiency(null, { item_description: 'a very detailed description of something' });
  assert.equal(result.sufficient, false);
  assert.equal(result.categoryValid, false);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].key, 'category');
});

test('an unknown category value is treated the same as no category', () => {
  const result = checkBuyingSufficiency('spaceship', {});
  assert.equal(result.sufficient, false);
  assert.equal(result.categoryValid, false);
});

test('the original bait-and-switch input ("fridge purchase 33 inch" as a bare description) is insufficient for the appliance category', () => {
  const result = checkBuyingSufficiency('appliance', {
    item_description: 'fridge purchase 33 inch',
  });
  assert.equal(result.sufficient, false);
  const missingKeys = result.missing.map((m) => m.key);
  // Everything else the report needs is genuinely absent from that one line.
  assert.ok(missingKeys.includes('price_value'));
  assert.ok(missingKeys.includes('financing'));
  assert.ok(missingKeys.includes('ownership_years'));
  assert.ok(missingKeys.includes('location'));
  assert.ok(missingKeys.includes('timeline'));
  assert.ok(missingKeys.includes('size_constraints'));
  assert.ok(missingKeys.includes('configuration'));
});

test('the real-world variant ("purchasing a new 33 inch bridge") is also insufficient even with a category guessed', () => {
  const result = checkBuyingSufficiency('other', {
    item_description: 'Purchasing a new 33 inch bridge',
  });
  assert.equal(result.sufficient, false);
  assert.ok(result.missing.some((m) => m.key === 'price_value'));
});

test('a fully specified appliance purchase is sufficient', () => {
  const values = {
    item_description: 'LG 33-inch French door refrigerator, model LRFXS2503S',
    price_value: '2400',
    financing: 'cash',
    ownership_years: '8',
    location: '30301',
    timeline: 'this_month',
    size_constraints: 'must fit a 33-inch-wide opening, standard depth',
    configuration: 'French door, counter-depth',
    // must_have_features and energy_priority are optional — omitted on purpose
  };
  const result = checkBuyingSufficiency('appliance', values);
  assert.equal(result.sufficient, true);
  assert.equal(result.missing.length, 0);
});

test('financing_term_months is only required when financing==="financing"', () => {
  const cashValues = {
    item_description: 'LG 33-inch French door refrigerator',
    price_value: '2400',
    financing: 'cash',
    ownership_years: '8',
    location: '30301',
    timeline: 'this_month',
    size_constraints: '33-inch opening',
    configuration: 'French door',
  };
  assert.equal(checkBuyingSufficiency('appliance', cashValues).sufficient, true);

  const financingValuesMissingTerm = { ...cashValues, financing: 'financing' };
  const financingResult = checkBuyingSufficiency('appliance', financingValuesMissingTerm);
  assert.equal(financingResult.sufficient, false);
  assert.ok(financingResult.missing.some((m) => m.key === 'financing_term_months'));

  const financingValuesComplete = { ...financingValuesMissingTerm, financing_term_months: '18' };
  assert.equal(checkBuyingSufficiency('appliance', financingValuesComplete).sufficient, true);
});

test('a fully specified vehicle purchase is sufficient and a partially specified one is not', () => {
  const complete = {
    item_description: '2023 Ford F-150 XLT',
    price_value: '38000',
    financing: 'financing',
    financing_term_months: '60',
    ownership_years: '6',
    location: 'Denver, CO',
    timeline: 'this_month',
    condition: 'new',
    annual_mileage: '12000',
  };
  assert.equal(checkBuyingSufficiency('vehicle', complete).sufficient, true);

  const { condition, annual_mileage, ...missingCategoryFields } = complete;
  const partial = checkBuyingSufficiency('vehicle', missingCategoryFields);
  assert.equal(partial.sufficient, false);
  const missingKeys = partial.missing.map((m) => m.key);
  assert.ok(missingKeys.includes('condition'));
  assert.ok(missingKeys.includes('annual_mileage'));
});

test('the "other" category requires usage_context in addition to the common fields', () => {
  const values = {
    item_description: 'a high-end espresso machine',
    price_value: '1800',
    financing: 'cash',
    ownership_years: '10',
    location: 'Austin, TX',
    timeline: 'researching',
  };
  const missingUsage = checkBuyingSufficiency('other', values);
  assert.equal(missingUsage.sufficient, false);
  assert.ok(missingUsage.missing.some((m) => m.key === 'usage_context'));

  const withUsage = checkBuyingSufficiency('other', { ...values, usage_context: 'daily home use, one shot a day' });
  assert.equal(withUsage.sufficient, true);
});

test('a zero or negative price does not count as filled', () => {
  const values = {
    item_description: 'a used sedan',
    price_value: '0',
    financing: 'cash',
    ownership_years: '5',
    location: '90210',
    timeline: 'this_week',
    condition: 'used',
    annual_mileage: '10000',
  };
  const result = checkBuyingSufficiency('vehicle', values);
  assert.equal(result.sufficient, false);
  assert.ok(result.missing.some((m) => m.key === 'price_value'));
});

test('every field has a non-empty "why" explanation, per the design requirement to explain each ask', () => {
  CATEGORIES.forEach((cat) => {
    fieldsForCategory(cat.value).forEach((field) => {
      assert.ok(field.why && field.why.length > 10, `${cat.value}/${field.key} is missing a "why" explanation`);
    });
  });
});

test('buildReadySummary produces a readable sentence referencing the key facts', () => {
  const summary = buildReadySummary('vehicle', {
    item_description: '2023 Ford F-150 XLT',
    price_value: '38000',
    financing: 'financing',
    financing_term_months: '60',
    ownership_years: '6',
    location: 'Denver, CO',
  });
  assert.match(summary, /F-150/);
  assert.match(summary, /\$38,000/);
  assert.match(summary, /financed over 60 months/);
  assert.match(summary, /6 years/);
  assert.match(summary, /Denver, CO/);
});

test('PROMISED_OUTPUTS lists exactly the six outputs the buying page advertises', () => {
  assert.equal(PROMISED_OUTPUTS.length, 6);
});
