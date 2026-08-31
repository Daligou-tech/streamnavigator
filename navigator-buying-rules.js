// Purchase Navigator sufficiency rules — the single source of truth for
// "do we have enough information to produce all six promised outputs
// (total cost of ownership, financing impact, maintenance/running costs,
// depreciation/resale, an alternative comparison, and a buy/wait/reconsider
// recommendation) BEFORE the customer is allowed to pay?"
//
// This file is isomorphic on purpose: buying.html loads it as a plain
// <script> (it attaches itself to `window`) and api/navigator-intake.js
// requires it as a CommonJS module (it attaches itself to `module.exports`
// when `module` exists). Same object, same logic, in both places — so the
// browser's live "you're missing X" UI and the server's authoritative
// pre-payment gate can never drift apart or disagree with each other.
//
// Root cause this exists to close: before this file, buying.html only
// checked that the description box wasn't empty, and api/navigator-intake.js
// only checked "non-empty description OR a file" (see D-04 in that file's
// comments). Both let a customer pay $19 for something like "fridge
// purchase 33 inch" or "purchasing a new 33 inch bridge" — no price, no
// financing info, no usage — and the AI could only honestly report back
// that there wasn't enough to work with. That's a bait-and-switch: the
// charge happens before anyone (human or AI) has looked at whether the
// input can support the report being sold. This file makes "enough
// information" a concrete, checkable, shared definition instead of
// something only discovered after payment.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NavigatorBuyingRules = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CATEGORIES = [
    { value: 'vehicle', label: 'Vehicle', icon: '🚗', hint: 'Car, truck, motorcycle, boat, RV…' },
    { value: 'appliance', label: 'Major appliance', icon: '🧊', hint: 'Fridge, washer/dryer, HVAC unit, range…' },
    { value: 'other', label: 'Other big-ticket item', icon: '📦', hint: 'Furniture, electronics, equipment…' },
  ];

  // Fields shared by every category. Order here is the order they render in.
  var COMMON_FIELDS = [
    {
      key: 'item_description',
      label: 'Item or model',
      type: 'text',
      required: true,
      placeholder: 'e.g. 2023 Ford F-150 XLT, or LG 33-inch French door refrigerator',
      why: 'Different items and models have very different maintenance, financing, and resale patterns — we need to know specifically what this is.',
      minLength: 5,
    },
    {
      key: 'price_value',
      label: 'Price you’ve been quoted, or your budget',
      type: 'currency',
      required: true,
      placeholder: 'e.g. 2400',
      why: 'Without a price we can’t calculate financing cost, project total cost of ownership, or compare against an alternative — this is the one number everything else is built on.',
      min: 1,
    },
    {
      key: 'financing',
      label: 'How are you paying?',
      type: 'select',
      required: true,
      options: [
        { value: 'cash', label: 'Cash / paying in full' },
        { value: 'financing', label: 'Financing it' },
      ],
      why: 'Financing changes the real cost significantly — interest adds up over the loan term, so we need to know before we can size that impact.',
    },
    {
      key: 'financing_term_months',
      label: 'Financing term (months)',
      type: 'number',
      required: true,
      requiredIf: { field: 'financing', equals: 'financing' },
      placeholder: 'e.g. 60',
      why: 'The loan term is what turns a price into a real financing cost — the same price financed over 2 years vs. 7 years costs very different amounts in interest.',
      min: 1,
      max: 480,
    },
    {
      key: 'ownership_years',
      label: 'Years you expect to keep it',
      type: 'number',
      required: true,
      placeholder: 'e.g. 5',
      why: 'Maintenance costs, depreciation, and whether this is even worth it all depend on how long you’ll actually own it.',
      min: 0.5,
      max: 50,
    },
    {
      key: 'location',
      label: 'Location (ZIP or city/state)',
      type: 'text',
      required: true,
      placeholder: 'e.g. 30301 or Atlanta, GA',
      why: 'Energy rates, insurance, taxes, and typical prices all vary a lot by region — this keeps the estimate grounded in your area instead of a generic national average.',
      minLength: 2,
    },
    {
      key: 'timeline',
      label: 'Purchase timeline',
      type: 'select',
      required: true,
      options: [
        { value: 'this_week', label: 'Within the next week' },
        { value: 'this_month', label: 'Within the next month' },
        { value: 'few_months', label: 'A few months out' },
        { value: 'researching', label: 'Just researching for now' },
      ],
      why: 'A "wait" recommendation is only useful if it fits your actual timeline — this tells us whether waiting is realistic for you.',
    },
    {
      key: 'must_have_features',
      label: 'Any must-have features or deal-breakers (optional)',
      type: 'text',
      required: false,
      placeholder: 'e.g. towing capacity, ice maker, quiet operation',
      why: 'Helps us pick a realistic alternative to compare against instead of a generic one.',
    },
  ];

  var CATEGORY_FIELDS = {
    vehicle: [
      {
        key: 'condition',
        label: 'New or used?',
        type: 'select',
        required: true,
        options: [
          { value: 'new', label: 'New' },
          { value: 'used', label: 'Used' },
        ],
        why: 'New vs. used changes the financing terms, the depreciation curve, and what warranty coverage applies.',
      },
      {
        key: 'annual_mileage',
        label: 'Expected annual mileage',
        type: 'number',
        required: true,
        placeholder: 'e.g. 12000',
        why: 'Mileage drives fuel and maintenance projections and materially affects resale value.',
        min: 0,
        max: 200000,
      },
    ],
    appliance: [
      {
        key: 'size_constraints',
        label: 'Size constraints',
        type: 'text',
        required: true,
        placeholder: 'e.g. must fit a 33-inch-wide opening',
        why: 'This determines which models are actually realistic alternatives to compare against — a great deal that doesn’t fit the space isn’t a useful comparison.',
        minLength: 2,
      },
      {
        key: 'configuration',
        label: 'Preferred configuration',
        type: 'text',
        required: true,
        placeholder: 'e.g. French door, counter-depth, front-load',
        why: 'Configuration changes both price and reliability/repair profile — a French-door fridge and a top-freezer fridge are not comparable purchases.',
        minLength: 2,
      },
      {
        key: 'energy_priority',
        label: 'How much do energy costs matter to you? (optional)',
        type: 'select',
        required: false,
        options: [
          { value: 'not_a_priority', label: 'Not a priority' },
          { value: 'somewhat', label: 'Somewhat important' },
          { value: 'very_important', label: 'Very important' },
        ],
        why: 'Lets us weight the running-cost comparison the way you actually care about it.',
      },
    ],
    other: [
      {
        key: 'usage_context',
        label: 'How and how often will you use it?',
        type: 'text',
        required: true,
        placeholder: 'e.g. daily home use, light commercial use a few times a week',
        why: 'How something is actually used drives its realistic lifespan and running costs far more than the sticker price does.',
        minLength: 5,
      },
    ],
  };

  function fieldsForCategory(category) {
    var extra = CATEGORY_FIELDS[category] || [];
    return COMMON_FIELDS.concat(extra);
  }

  function isFieldApplicable(field, values) {
    if (!field.requiredIf) return true;
    return values[field.requiredIf.field] === field.requiredIf.equals;
  }

  function isFieldFilled(field, rawValue) {
    if (rawValue === undefined || rawValue === null) return false;
    if (field.type === 'number' || field.type === 'currency') {
      var num = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue).replace(/[^0-9.\-]/g, ''));
      if (isNaN(num)) return false;
      if (typeof field.min === 'number' && num < field.min) return false;
      if (typeof field.max === 'number' && num > field.max) return false;
      return true;
    }
    var str = String(rawValue).trim();
    if (!str) return false;
    if (field.minLength && str.length < field.minLength) return false;
    if (field.type === 'select' && field.options) {
      return field.options.some(function (o) { return o.value === str; });
    }
    return true;
  }

  // The core gate. `category` is one of CATEGORIES[].value or null/empty.
  // `values` is a flat object of field key -> raw value (strings from form
  // inputs are fine; numeric coercion happens here).
  function checkBuyingSufficiency(category, values) {
    values = values || {};
    if (!category || !CATEGORY_FIELDS[category]) {
      return {
        sufficient: false,
        categoryValid: false,
        missing: [{ key: 'category', label: 'What kind of purchase is this?', why: 'The questions we ask (and the alternative we compare against) depend on whether this is a vehicle, an appliance, or something else.' }],
        requiredCount: 0,
        filledCount: 0,
      };
    }

    var fields = fieldsForCategory(category);
    var missing = [];
    var requiredCount = 0;
    var filledCount = 0;

    fields.forEach(function (field) {
      if (!isFieldApplicable(field, values)) return;
      if (!field.required) return;
      requiredCount++;
      var filled = isFieldFilled(field, values[field.key]);
      if (filled) {
        filledCount++;
      } else {
        missing.push({ key: field.key, label: field.label, why: field.why });
      }
    });

    return {
      sufficient: missing.length === 0,
      categoryValid: true,
      missing: missing,
      requiredCount: requiredCount,
      filledCount: filledCount,
    };
  }

  var PROMISED_OUTPUTS = [
    'True total cost of ownership, not just the purchase price',
    'Financing-cost impact if you’re not paying cash',
    'Expected maintenance and running costs over time',
    'Depreciation or resale-value expectations',
    'A comparison with at least one realistic alternative',
    'A clear buy / wait / reconsider recommendation',
  ];

  function buildReadySummary(category, values) {
    var catLabel = (CATEGORIES.filter(function (c) { return c.value === category; })[0] || {}).label || 'item';
    var price = values.price_value ? ('$' + Number(String(values.price_value).replace(/[^0-9.]/g, '')).toLocaleString('en-US') ) : null;
    var financeBit = values.financing === 'financing'
      ? ('financed over ' + (values.financing_term_months || '?') + ' months')
      : 'paid in cash';
    var years = values.ownership_years ? (values.ownership_years + ' year' + (Number(values.ownership_years) === 1 ? '' : 's')) : null;
    var parts = [];
    parts.push((values.item_description || ('this ' + catLabel.toLowerCase())));
    if (price) parts.push('priced around ' + price);
    parts.push(financeBit);
    if (years) parts.push('kept for about ' + years);
    if (values.location) parts.push('in ' + values.location);
    return 'We’ll analyze ' + parts.join(', ') + '.';
  }

  return {
    CATEGORIES: CATEGORIES,
    COMMON_FIELDS: COMMON_FIELDS,
    CATEGORY_FIELDS: CATEGORY_FIELDS,
    PROMISED_OUTPUTS: PROMISED_OUTPUTS,
    fieldsForCategory: fieldsForCategory,
    isFieldApplicable: isFieldApplicable,
    isFieldFilled: isFieldFilled,
    checkBuyingSufficiency: checkBuyingSufficiency,
    buildReadySummary: buildReadySummary,
  };
});
