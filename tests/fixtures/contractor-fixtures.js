'use strict';

// Two jobs, transcribed the way api/_lib/contractor-extract.js should record
// them. Both are built from the things that actually go wrong on a contractor
// estimate rather than from the things that are easy to assert about.
//
// `pressuredHvac` is the in-home sales visit: one quote, a deposit over
// California's statutory cap, a line that does not multiply out, a tax credit
// that ended on 31 December 2025, R-410A stock, an unmatched system, and a
// price that expires tonight. Every one of those is a separate check and none
// of them is the thing a model reading the document would have led with.
//
// `twoRoofs` is the ordinary good case: two competing quotes, mostly clean,
// where the value is the comparison rather than a scandal.

function pressuredHvac() {
  return {
    category: 'HVAC',
    documents_seen: ['Comfort Kings Heating & Air — proposal, 2 pages'],
    quotes: [
      {
        label: 'Quote 1',
        contractor_name: 'Comfort Kings Heating & Air',
        license_number: null,
        quote_date: '2026-09-08',
        quote_expires: '2026-09-10',

        total_price: 14850,
        subtotal: 13750,
        tax_amount: 1100,
        tax_rate_stated: 8.0,

        line_items_are_priced: true,
        line_items_complete: true,
        line_items: [
          { description: '3-ton condenser, R-410A', quantity: 1, unit: 'each', unit_price: 6400, amount: 6400 },
          { description: 'Installation labour', quantity: 16, unit: 'hour', unit_price: 145, amount: 2520 },
          { description: 'Thermostat and electrical', quantity: 1, unit: 'each', unit_price: 850, amount: 850 },
          { description: 'Duct sealing allowance', quantity: 1, unit: 'each', unit_price: 1500, amount: 1500, is_allowance: true },
          { description: 'Miscellaneous materials', quantity: 1, unit: 'each', unit_price: 2480, amount: 2480 },
        ],

        deposit_amount: 4000,
        deposit_percent_stated: null,
        payment_schedule: [
          { trigger: 'At signing', amount: 4000, is_before_work_starts: true },
          { trigger: 'On completion', amount: 10850, is_before_work_starts: false },
        ],

        start_date_stated: true,
        completion_date_stated: false,
        permit: 'not_mentioned',
        haul_away_disposal: 'not_mentioned',

        warranty_labor_years: 1,
        warranty_materials_years: null,

        exclusions: [],
        change_order_clause: 'absent',
        lien_waiver_mentioned: false,
        insurance_evidence_mentioned: false,
        right_to_cancel_notice: false,

        financing_offered: true,
        financing_apr_stated: null,
        financing_promo_text: '0% for 18 months with approved credit',
        tax_credit_claims: ['Ask us about your $2,000 federal energy tax credit!'],
        pressure_language: ['This price is good through today only'],

        hvac: {
          tons: 3,
          seer2: 14.5,
          refrigerant: 'R-410A',
          system_type: 'split system AC',
          indoor_unit_included: false,
          ductwork: 'not_mentioned',
          line_set: 'not_mentioned',
          load_calculation_mentioned: false,
          brand: 'Goodman',
        },
      },
    ],
    scope_lines: ['Replace outdoor condensing unit, reuse existing coil'],
    unreadable: [],
  };
}

function twoRoofs() {
  return {
    category: 'Roofing',
    documents_seen: ['Apex Roofing — estimate', 'Beacon Exteriors — proposal'],
    quotes: [
      {
        label: 'Quote 1',
        contractor_name: 'Apex Roofing',
        license_number: 'CCC1331892',
        quote_date: '2026-09-02',
        total_price: 18400,
        subtotal: 18400,

        line_items_are_priced: true,
        line_items_complete: true,
        line_items: [
          { description: 'Tear off two layers, 26 squares', quantity: 26, unit: 'square', unit_price: 190, amount: 4940 },
          { description: 'Architectural shingles installed', quantity: 26, unit: 'square', unit_price: 420, amount: 10920 },
          { description: 'Synthetic underlayment', quantity: 26, unit: 'square', unit_price: 55, amount: 1430 },
          { description: 'Drip edge, valley and pipe flashing', quantity: 1, unit: 'each', unit_price: 1110, amount: 1110 },
        ],

        deposit_amount: 1840,
        payment_schedule: [
          { trigger: 'At signing', amount: 1840, is_before_work_starts: true },
          { trigger: 'On completion', amount: 16560, is_before_work_starts: false },
        ],

        start_date_stated: true,
        completion_date_stated: true,
        permit: 'included',
        haul_away_disposal: 'included',

        warranty_labor_years: 10,
        warranty_materials_years: 30,

        exclusions: ['Decking replacement beyond 3 sheets', 'Chimney masonry repair'],
        change_order_clause: 'written_approval_required',
        lien_waiver_mentioned: true,
        insurance_evidence_mentioned: true,
        right_to_cancel_notice: true,

        financing_offered: false,
        tax_credit_claims: [],
        pressure_language: [],

        roofing: {
          squares: 26,
          tear_off: 'full_tear_off',
          layers_removed: 2,
          shingle_type: 'Architectural, 30-year',
          underlayment: 'included',
          ice_water_shield: 'included',
          drip_edge: 'included',
          ventilation: 'included',
          flashing: 'new',
          decking_terms: 'First 3 sheets included; additional sheets $95 each, photographed before replacement.',
        },
      },
      {
        label: 'Quote 2',
        contractor_name: 'Beacon Exteriors',
        license_number: 'CCC1529004',
        quote_date: '2026-09-05',
        total_price: 13900,
        subtotal: 13900,

        line_items_are_priced: false,
        line_items_complete: true,
        line_items: [],

        deposit_amount: 6950,
        payment_schedule: [
          { trigger: 'At signing', amount: 6950, is_before_work_starts: true },
          { trigger: 'On completion', amount: 6950, is_before_work_starts: false },
        ],

        start_date_stated: true,
        completion_date_stated: false,
        permit: 'owner_responsibility',
        haul_away_disposal: 'included',

        warranty_labor_years: 2,
        warranty_materials_years: 25,

        exclusions: [],
        change_order_clause: 'mentioned_without_terms',
        lien_waiver_mentioned: false,
        insurance_evidence_mentioned: true,
        right_to_cancel_notice: false,

        financing_offered: false,
        tax_credit_claims: [],
        pressure_language: [],

        roofing: {
          squares: 26,
          tear_off: 'overlay',
          shingle_type: '3-tab, 25-year',
          underlayment: 'included',
          ice_water_shield: 'not_mentioned',
          drip_edge: 'not_mentioned',
          ventilation: 'not_mentioned',
          flashing: 'reused',
        },
      },
    ],
    scope_lines: ['Replace main roof, 26 squares'],
    unreadable: [],
  };
}

// The thin case: a phone photograph of a handwritten quote. Almost nothing is
// extractable, which is the result the refund floor exists for.
function unreadableScrap() {
  return {
    category: 'Plumbing',
    documents_seen: ['Photograph of a handwritten note'],
    quotes: [
      {
        label: 'Quote 1',
        contractor_name: null,
        total_price: null,
        line_items_are_priced: false,
        line_items_complete: false,
        line_items: [],
        payment_schedule: [],
        exclusions: [],
        tax_credit_claims: [],
        pressure_language: [],
      },
    ],
    scope_lines: [],
    unreadable: ['The total was written over and could not be read', 'The second half of the page is out of frame'],
  };
}

module.exports = { pressuredHvac, twoRoofs, unreadableScrap };
