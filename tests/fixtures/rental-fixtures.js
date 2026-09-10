'use strict';

// Two rental properties, transcribed as api/_lib/rental-extract.js should record
// them, shared by every test that exercises the audit engine.
//
// The four-unit property is the one from the 2026-09-09 product audit whose
// findings the model-only pipeline missed. The duplex is its control: a
// well-run property where the correct number of findings against the landlord
// is zero, and where a check set that invents one is doing harm.

// 1428 Garfield Ave: four identical units, one of them $312.50/month under the
// median of the other three, water on a master meter, a 2004 condenser taking
// service calls, and a managed statement that does not foot.
function leakyFourplex() {
  return {
    property: { address: '1428 Garfield Ave, Kansas City, MO 64127', unit_count: 4, year_built: 1964, purchase_price: 385000 },
    units: [
      { unit_id: '1', bedrooms: 2, bathrooms: 1, sqft: 780, monthly_rent: 950, lease_end: '11/30/2026' },
      { unit_id: '2', bedrooms: 2, bathrooms: 1, sqft: 780, monthly_rent: 1275, lease_end: '07/31/2027' },
      { unit_id: '3', bedrooms: 2, bathrooms: 1, sqft: 780, monthly_rent: 1250, lease_end: '04/30/2027' },
      { unit_id: '4', bedrooms: 2, bathrooms: 1, sqft: 795, monthly_rent: 1300, lease_end: '01/31/2027' },
    ],
    income: {
      gross_scheduled_rent: 57300, vacancy_loss: 2500, collected_rent: 54800,
      other_income: 1140, total_collected: 55940, net_operating_income: 15252,
    },
    expenses: [
      { label: 'Management fee', category: 'management', annual_amount: 5480 },
      { label: 'Leasing fee', category: 'leasing_turnover', annual_amount: 625 },
      { label: 'Turnover administration fee', category: 'leasing_turnover', annual_amount: 250 },
      { label: 'Unit 3 make-ready', category: 'leasing_turnover', annual_amount: 975 },
      { label: 'Repairs & maintenance', category: 'repairs_maintenance', annual_amount: 7400 },
      { label: 'Water & sewer', category: 'water_sewer', annual_amount: 6240 },
      { label: 'Trash service', category: 'trash', annual_amount: 1140 },
      { label: 'Common-area electric', category: 'electric', annual_amount: 1320 },
      { label: 'Lawn care', category: 'landscaping', annual_amount: 1800 },
      { label: 'Snow removal', category: 'snow', annual_amount: 1200 },
      { label: 'Home warranty plan', category: 'warranty', annual_amount: 1788 },
      { label: 'Property insurance', category: 'insurance', annual_amount: 4860 },
      { label: 'Property taxes', category: 'taxes', annual_amount: 6180 },
      { label: 'Pest control', category: 'pest', annual_amount: 480 },
      { label: 'Accounting', category: 'admin', annual_amount: 950 },
    ],
    expense_total_stated: 40688,
    maintenance_items: [
      { date: '09/18/25', unit_id: '2', description: 'HVAC service call, no cooling', amount: 385, system: 'hvac' },
      { date: '10/02/25', description: 'Gutter cleaning', amount: 340, system: 'exterior' },
      { date: '11/14/25', unit_id: '4', description: 'Garbage disposal replacement', amount: 295, system: 'appliance' },
      { date: '12/03/25', unit_id: '2', description: 'HVAC blower motor capacitor', amount: 420, system: 'hvac' },
      { date: '12/21/25', description: 'Common hallway light fixtures', amount: 265, system: 'electrical' },
      { date: '01/09/26', unit_id: '1', description: 'Kitchen faucet leak, drain clearing', amount: 330, system: 'plumbing' },
      { date: '01/27/26', description: 'Roof flashing patch', amount: 680, system: 'roof' },
      { date: '02/11/26', unit_id: '2', description: 'HVAC no heat, ignitor', amount: 495, system: 'hvac' },
      { date: '02/28/26', description: 'Basement main line drain clearing', amount: 340, system: 'plumbing' },
      { date: '03/15/26', unit_id: '3', description: 'Make-ready tub valve', amount: 410, system: 'plumbing' },
      { date: '04/22/26', unit_id: '1', description: 'Drain clearing, kitchen line', amount: 310, system: 'plumbing' },
      { date: '05/30/26', unit_id: '2', description: 'HVAC refrigerant leak', amount: 610, system: 'hvac' },
      { date: '06/12/26', description: 'Basement main line drain clearing', amount: 340, system: 'plumbing' },
      { date: '07/08/26', unit_id: '2', description: 'HVAC condenser fan motor', amount: 465, system: 'hvac' },
      { date: '07/25/26', description: 'Tuckpointing, south wall', amount: 890, system: 'exterior' },
      { date: '08/14/26', unit_id: '1', description: 'Drain clearing, kitchen line, recurring', amount: 325, system: 'plumbing' },
    ],
    maintenance_total_stated: 7400,
    utility_months: [
      { utility: 'water_sewer', month: 'Sep 25', amount: 412 }, { utility: 'water_sewer', month: 'Oct 25', amount: 398 },
      { utility: 'water_sewer', month: 'Nov 25', amount: 405 }, { utility: 'water_sewer', month: 'Dec 25', amount: 421 },
      { utility: 'water_sewer', month: 'Jan 26', amount: 433 }, { utility: 'water_sewer', month: 'Feb 26', amount: 418 },
      { utility: 'water_sewer', month: 'Mar 26', amount: 441 }, { utility: 'water_sewer', month: 'Apr 26', amount: 529 },
      { utility: 'water_sewer', month: 'May 26', amount: 618 }, { utility: 'water_sewer', month: 'Jun 26', amount: 703 },
      { utility: 'water_sewer', month: 'Jul 26', amount: 741 }, { utility: 'water_sewer', month: 'Aug 26', amount: 721 },
    ],
    utilities_owner_paid: [{ utility: 'water and sewer', annual_amount: 6240, submetered: false }],
    loan: {
      original_amount: 289000, current_balance: 253412.88, interest_rate: 4.75,
      principal_and_interest_monthly: 1565.42, mortgage_insurance_monthly: 118,
      escrow_monthly: 920, escrow_taxes_annual: 6180, escrow_insurance_annual: 4860,
    },
    debt_service: { principal_interest_annual: 18785.04, mortgage_insurance_annual: 1416, total_annual: 20201.04 },
    insurance: {
      annual_premium: 4860, prior_premium: 4120, dwelling_limit: 612000,
      liability_limit: 1000000, deductible_all_perils: 1000, discounts_applied: false,
    },
    management: {
      self_managed: false, company_name: 'Meridian Property Group, LLC',
      fee_percent: 0.10, fee_basis: 'collected', fee_annual: 5480, turnover_fees_annual: 1850,
    },
    taxes: { annual_amount: 6180 },
    documents_seen: ['rent roll', 'owner statement', 'mortgage statement', 'insurance declarations'],
  };
}

// 2211 Ashland Court: a well-run self-managed duplex. Nothing here should be
// flagged, and a check set that manufactures a finding on this fixture is worse
// than useless — it would be charging a landlord to be worried.
function cleanDuplex() {
  return {
    property: { address: '2211 Ashland Court, Columbus, OH 43209', unit_count: 2, year_built: 2006, purchase_price: 312000 },
    units: [
      { unit_id: 'A', bedrooms: 3, bathrooms: 2, sqft: 1180, monthly_rent: 1695, lease_end: '08/31/2027' },
      { unit_id: 'B', bedrooms: 3, bathrooms: 2, sqft: 1180, monthly_rent: 1675, lease_end: '06/30/2027' },
    ],
    income: { gross_scheduled_rent: 40440, vacancy_loss: 0, total_collected: 40440, net_operating_income: 28234 },
    expenses: [
      { label: 'Repairs & maintenance', category: 'repairs_maintenance', annual_amount: 3180 },
      { label: 'Common-area electric', category: 'electric', annual_amount: 216 },
      { label: 'Lawn care', category: 'landscaping', annual_amount: 180 },
      { label: 'Property insurance', category: 'insurance', annual_amount: 2240 },
      { label: 'Property taxes', category: 'taxes', annual_amount: 5940 },
      { label: 'Accounting', category: 'admin', annual_amount: 450 },
    ],
    expense_total_stated: 12206,
    maintenance_items: [
      { date: '10/2025', unit_id: 'A', description: 'Water heater anode rod', amount: 185, system: 'plumbing' },
      { date: '11/2025', description: 'Gutter cleaning', amount: 240, system: 'exterior' },
      { date: '01/2026', unit_id: 'B', description: 'Dishwasher replacement', amount: 615, system: 'appliance' },
      { date: '03/2026', description: 'HVAC annual service', amount: 380, system: 'hvac' },
      { date: '04/2026', description: 'Exterior paint and caulking', amount: 420, system: 'exterior' },
      { date: '06/2026', unit_id: 'A', description: 'Garbage disposal replacement', amount: 310, system: 'appliance' },
      { date: '07/2026', description: 'Driveway seal coat', amount: 680, system: 'exterior' },
      { date: '08/2026', description: 'HVAC service, filters', amount: 350, system: 'hvac' },
    ],
    maintenance_total_stated: 3180,
    utilities_owner_paid: [],
    loan: { original_amount: 234000, current_balance: 210400, interest_rate: 3.125, mortgage_insurance_monthly: 0 },
    debt_service: { principal_interest_annual: 14186.28, total_annual: 14186.28 },
    management: { self_managed: true },
    documents_seen: ['rent roll', 'operating statement'],
  };
}

module.exports = { leakyFourplex, cleanDuplex };
