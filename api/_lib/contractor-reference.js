'use strict';

// Everything Contractor Navigator knows that is not in the customer's own
// documents.
//
// The page used to say "AI researches the context — typical price ranges and
// what's normal for this category are factored in." Nothing researched
// anything. One Sonnet call read the estimate and wrote a verdict, and the
// "typical range" behind that verdict was whatever the model happened to
// recall: unnamed, uncited, and different on every run. A homeowner cannot
// take "the AI thought it was high" to a contractor.
//
// So the ranges live here instead — written down, sourced, dated, and stated
// as what they actually are. A published national cost band is not a local
// comp, and no check in this product is allowed to pretend otherwise. The
// strongest thing a band may conclude is "your number falls outside every
// published national range for this work", which is a fact a homeowner can
// act on. The second-strongest is "it falls inside them", which is not proof
// of a good price and is reported as not proof of a good price.
//
// The legal figures are different in kind and are treated differently. A
// statutory deposit cap is a number in a statute; a quote that exceeds it is a
// finding with a citation, not an opinion.
//
// Every entry carries `source` because api/_lib/contractor-audit.js prints it
// into the finding. A number in here without a source cannot be used.

// --- what counts as a US state, for the checks that need one ---------------

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

function stateName(code) {
  return STATES[String(code || '').toUpperCase()] || null;
}

// Dollars, formatted the one way this product formats them.
//
// The statutory `basis` strings below are printed straight into a finding
// alongside figures formatted by api/_lib/contractor-audit.js, and a sentence
// reading "10% of $14850.00 is $1485.00" beside "$4,000.00" is a sentence a
// homeowner reads twice and trusts slightly less.
function usd(n) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// --- statutory deposit caps -------------------------------------------------
//
// Only states whose cap is a number in a statute are listed. The temptation is
// to fill in the other forty-five with "industry norm, 10-33%", and that is
// exactly the move this file exists to refuse: a norm and a statute produce
// different sentences in the report and different leverage on the phone. Where
// there is no statutory cap the check says there is no statutory cap, and the
// norm is offered separately and labelled as a norm.
//
// `rule` returns { cap, basis } for a contract price, or null where the statute
// does not reach that price.

const DEPOSIT_CAPS = {
  CA: {
    label: 'the lesser of $1,000 or 10% of the contract price',
    citation: 'California Business and Professions Code section 7159.5(a)(3)',
    source: 'https://california.public.law/codes/business_and_professions_code_section_7159.5',
    rule: (price) => ({
      cap: Math.min(1000, price * 0.10),
      basis: 'California caps a home improvement down payment at the lesser of $1,000 or 10% of the contract price. '
        + `10% of ${usd(price)} is ${usd(price * 0.10)}, so the cap here is ${usd(Math.min(1000, price * 0.10))}.`,
    }),
    contractLanguage: 'The contract itself must carry a "Down Payment" heading and the sentence "THE DOWN PAYMENT MAY '
      + 'NOT EXCEED $1,000 OR 10 PERCENT OF THE CONTRACT PRICE, WHICHEVER IS LESS" in at least 12-point boldface.',
  },
  NV: {
    label: 'the lesser of $1,000 or 10% of the aggregate contract price',
    citation: 'Nevada Revised Statutes section 624.970',
    source: 'https://law.justia.com/codes/nevada/chapter-624/statute-624-970/',
    rule: (price) => ({
      cap: Math.min(1000, price * 0.10),
      basis: 'Nevada caps the down payment on a residential improvement contract at the lesser of $1,000 or 10% of the '
        + `aggregate contract price. 10% of ${usd(price)} is ${usd(price * 0.10)}.`,
    }),
    // The cap lifts where the contractor furnishes a performance bond for the
    // full amount. The check has to say that rather than assert a breach.
    exception: 'This cap does not apply if the contractor furnishes a performance bond covering the full contract price.',
  },
  MD: {
    label: 'one third of the contract price',
    citation: 'Maryland Home Improvement Law, Business Regulation section 8-501 et seq.',
    source: 'https://www.dllr.state.md.us/license/mhic/',
    rule: (price) => ({
      cap: price / 3,
      basis: `Maryland caps a home improvement deposit at one third of the contract price — ${usd(price / 3)} here.`,
    }),
  },
  MA: {
    label: 'one third of the contract price, or the cost of special-order materials if that is greater',
    citation: 'Massachusetts General Laws chapter 142A section 2',
    source: 'https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXX/Chapter142A/Section2',
    rule: (price) => ({
      cap: price / 3,
      basis: `Massachusetts caps the deposit at one third of the total contract price — ${usd(price / 3)} here — `
        + 'or the cost of special-order materials, whichever is greater.',
    }),
    exception: 'A larger deposit is permitted only to cover special-order materials, which the contract has to identify.',
  },
  PA: {
    label: 'one third of the contract price, plus separately itemised special-order materials',
    citation: 'Pennsylvania Home Improvement Consumer Protection Act, 73 P.S. section 517.7(e)',
    source: 'https://www.attorneygeneral.gov/wp-content/uploads/2018/01/Act_132_Home_Improvement.pdf',
    // The Act reaches contracts over $5,000.
    rule: (price) => (price > 5000
      ? {
        cap: price / 3,
        basis: `Pennsylvania caps the deposit at one third of the contract price — ${usd(price / 3)} here — `
          + 'plus the separately itemised cost of special-order materials.',
      }
      : null),
    exception: 'Special-order materials may be charged on top of the one-third cap, but the contract must list them separately.',
  },
};

// New York does not cap the amount; it regulates where the money sits. A
// different finding, so a different table rather than a fudged entry above.
const DEPOSIT_ESCROW_RULES = {
  NY: {
    label: 'money taken before substantial completion must be held in escrow',
    citation: 'New York General Business Law section 71-a',
    source: 'https://www.nysenate.gov/legislation/laws/GBS/71-A',
    note: 'New York sets no maximum deposit. It requires that any payment taken before the work is substantially '
      + 'complete be deposited into an escrow account, or else be covered by a bond, a contract of indemnity, or a '
      + 'letter of credit. Ask in writing which of those applies to your deposit.',
  },
};

// What is customary everywhere else, offered as a norm and never as a rule.
const DEPOSIT_NORM = {
  typicalMaxPercent: 33,
  comfortablePercent: 10,
  source: 'Customary practice, not statute. Published guidance clusters at 10%-33% of contract price for residential work.',
};

// --- contractor licence lookup ---------------------------------------------
//
// The highest-value thirty seconds a homeowner can spend, and the one thing
// this report deliberately does not do on their behalf: we name the board and
// tell them to look it up, because a licence status read today is worth more
// than one we read at report time and then printed as though it were still true.

const LICENSE_BOARDS = {
  CA: { name: 'California Contractors State License Board (CSLB)', url: 'https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx' },
  NV: { name: 'Nevada State Contractors Board', url: 'https://www.nvcontractorsboard.com/' },
  AZ: { name: 'Arizona Registrar of Contractors', url: 'https://roc.az.gov/' },
  FL: { name: 'Florida DBPR licence search', url: 'https://www.myfloridalicense.com/wl11.asp' },
  TX: { name: 'Texas Department of Licensing and Regulation (HVAC and electrical; most other trades are city-licensed)', url: 'https://www.tdlr.texas.gov/LicenseSearch/' },
  NY: { name: 'New York licenses home improvement by county or city — start with your county consumer affairs office', url: 'https://dos.ny.gov/licensing' },
  MD: { name: 'Maryland Home Improvement Commission (MHIC)', url: 'https://www.dllr.state.md.us/license/mhic/' },
  MA: { name: 'Massachusetts Home Improvement Contractor registry', url: 'https://www.mass.gov/how-to/check-a-home-improvement-contractor-registration' },
  PA: { name: 'Pennsylvania Attorney General HICPA registry', url: 'https://hicsearch.attorneygeneral.gov/' },
  NJ: { name: 'New Jersey Division of Consumer Affairs home improvement registry', url: 'https://www.njconsumeraffairs.gov/hic' },
  WA: { name: 'Washington L&I "Verify a Contractor"', url: 'https://secure.lni.wa.gov/verify/' },
  OR: { name: 'Oregon Construction Contractors Board', url: 'https://www.oregon.gov/CCB/Pages/index.aspx' },
  VA: { name: 'Virginia DPOR licence lookup', url: 'https://www.dpor.virginia.gov/LicenseLookup' },
  NC: { name: 'North Carolina Licensing Board for General Contractors', url: 'https://nclbgc.org/' },
  GA: { name: 'Georgia Secretary of State licence verification', url: 'https://verify.sos.ga.gov/verification/' },
  CO: { name: 'Colorado licenses most trades at city or county level — ask your local building department', url: 'https://dpo.colorado.gov/' },
  IL: { name: 'Illinois licenses most trades at city or county level — ask your local building department', url: 'https://idfpr.illinois.gov/' },
  MI: { name: 'Michigan LARA licence verification', url: 'https://www.michigan.gov/lara' },
  OH: { name: 'Ohio Construction Industry Licensing Board (HVAC, electrical, plumbing, hydronics)', url: 'https://com.ohio.gov/divisions-and-programs/industrial-compliance' },
  MN: { name: 'Minnesota Department of Labor and Industry licence lookup', url: 'https://www.dli.mn.gov/business/contractors' },
  UT: { name: 'Utah DOPL licence search', url: 'https://secure.utah.gov/llv/search/index.html' },
  TN: { name: 'Tennessee Board for Licensing Contractors', url: 'https://www.tn.gov/commerce/regboards/contractors.html' },
};

// Every state has somewhere to look, even where we do not track the URL.
function licenseBoard(code) {
  const key = String(code || '').toUpperCase();
  if (LICENSE_BOARDS[key]) return LICENSE_BOARDS[key];
  const name = stateName(key);
  if (!name) return null;
  return {
    name: `${name} has no single statewide registry we track — ask your city or county building department who `
      + 'licenses this trade, and ask the contractor for their number either way',
    url: null,
    generic: true,
  };
}

// --- DOE regional efficiency standards --------------------------------------
//
// Federal minimums, in force since 1 January 2023. A split system below the
// minimum for its region cannot lawfully be installed there, so a quote naming
// one is a concrete finding rather than a preference.

const SEER2_SOUTHEAST = ['AL', 'AR', 'DE', 'DC', 'FL', 'GA', 'HI', 'KY', 'LA', 'MD', 'MS', 'NC', 'OK', 'SC', 'TN', 'TX', 'VA'];
const SEER2_SOUTHWEST = ['AZ', 'CA', 'NM', 'NV'];

const EFFICIENCY_SOURCE = {
  citation: 'US Department of Energy regional efficiency standards for central air conditioners and heat pumps, '
    + 'effective 1 January 2023',
  source: 'https://www.energy.gov/eere/buildings/articles/residential-central-air-conditioners-and-heat-pumps',
};

function efficiencyRegion(code) {
  const key = String(code || '').toUpperCase();
  if (!stateName(key)) return null;
  if (SEER2_SOUTHEAST.includes(key)) {
    return Object.assign({ region: 'Southeast', minSplitAcSeer2: 14.3, minHeatPumpSeer2: 14.3 }, EFFICIENCY_SOURCE);
  }
  if (SEER2_SOUTHWEST.includes(key)) {
    return Object.assign({ region: 'Southwest', minSplitAcSeer2: 14.3, minHeatPumpSeer2: 14.3 }, EFFICIENCY_SOURCE);
  }
  return Object.assign({ region: 'North', minSplitAcSeer2: 13.4, minHeatPumpSeer2: 14.3 }, EFFICIENCY_SOURCE);
}

// --- refrigerant transition -------------------------------------------------
//
// Not a violation, and the check must not present it as one. Manufacture of new
// R-410A residential systems ended on 1 January 2025 under the EPA AIM Act HFC
// phasedown; installing remaining stock was never prohibited. So a 2026 quote
// naming R-410A is a real fact about the equipment with real consequences for
// the homeowner — and a real negotiating position, because it is stock the
// distributor wants to clear.

const REFRIGERANT_TRANSITION = {
  endOfManufacture: '2025-01-01',
  supersededBy: ['R-454B', 'R-32'],
  citation: 'EPA AIM Act HFC phasedown. New residential air conditioners and heat pumps using R-410A (GWP 2,088) '
    + 'ceased manufacture on 1 January 2025; the replacement A2L refrigerants are R-454B and R-32',
  source: 'https://www.epa.gov/climate-hfcs-reduction',
};

// --- federal tax credits ----------------------------------------------------
//
// Here because of what it now says rather than what it offers. The Energy
// Efficient Home Improvement Credit was terminated for property placed in
// service after 31 December 2025. Sales literature written while it existed did
// not stop circulating when it ended, and "you get $2,000 back from the IRS" is
// still being said across HVAC and window sales. A quote whose price is
// justified by a credit that no longer exists is a finding worth the price of
// the report on its own.

const TAX_CREDIT_25C = {
  status: 'expired',
  expiredAfter: '2025-12-31',
  citation: '26 U.S.C. section 25C, terminated for property placed in service after 31 December 2025 by the budget '
    + 'reconciliation act enacted 4 July 2025',
  source: 'https://www.energystar.gov/about/federal-tax-credits',
  note: 'Work placed in service during 2025 can still be claimed on a 2025 return. Nothing installed in 2026 qualifies.',
};

// --- published national price bands -----------------------------------------
//
// Read the header of this file before adding to this table. These are
// consolidated published national cost-guide ranges. They are deliberately
// WIDE, because the honest width of a national range is wide, and a check built
// on one may only ever conclude "outside every published band" or "inside
// them". Narrowing a band so a report can say something sharper would be
// inventing a comp.
//
// `unit` is what the band is per. `low` and `high` bound the installed cost,
// equipment and labour together.

const PRICE_BANDS = {
  hvac_ac_per_ton: {
    unit: 'ton of cooling capacity, installed',
    low: 1400,
    high: 3400,
    label: 'central air conditioner or heat pump replacement, existing ductwork',
    source: 'Consolidated from 2026 published national cost guides (Angi, This Old House, and the Carrier and Bryant '
      + 'homeowner pricing guides). Installed cost including equipment, labour and a standard permit.',
    caveat: 'Ductwork replacement, electrical upgrades, zoning, and difficult access all sit outside this band '
      + 'legitimately.',
  },
  roofing_per_square: {
    unit: 'roofing square (100 sq ft), installed',
    low: 350,
    high: 1000,
    label: 'asphalt shingle roof replacement including tear-off',
    source: 'Consolidated from 2026 published national cost guides (This Old House, Homewyse, Modernize), converted '
      + 'from the $3.50-$10.00 per square foot installed range they report.',
    caveat: 'Steep pitch, multiple storeys, structural decking replacement, and premium or designer shingles all push '
      + 'above this band legitimately.',
  },
  windows_per_window: {
    unit: 'window, installed',
    low: 400,
    high: 1400,
    label: 'replacement window, standard size, vinyl or composite frame',
    source: 'Consolidated from 2026 published national cost guides (This Old House, Modernize, GetWindowCost).',
    caveat: 'Full-frame replacement, wood or fibreglass frames, oversized or custom shapes, and historic-district '
      + 'requirements all sit above this band legitimately.',
  },
  water_heater_tank: {
    unit: 'unit, installed',
    low: 850,
    high: 2600,
    label: 'standard 40-50 gallon tank water heater replacement',
    source: 'Consolidated from 2026 published national cost guides (Angi, NerdWallet, Homewyse).',
    caveat: 'Relocation, venting changes, expansion tanks and code upgrades are extra and are often genuinely needed.',
  },
  water_heater_tankless: {
    unit: 'unit, installed',
    low: 1400,
    high: 4500,
    label: 'tankless water heater replacement',
    source: 'Consolidated from 2026 published national cost guides (Angi, NerdWallet).',
    caveat: 'Gas line upsizing and new venting are common on a tank-to-tankless conversion and can add materially.',
  },
  electrical_panel_200a: {
    unit: 'panel, installed',
    low: 1300,
    high: 4800,
    label: '200-amp electrical service panel upgrade',
    source: 'Consolidated from 2026 published national cost guides (This Old House, HomeCostLab).',
    caveat: 'A new meter base, service entrance cable, or utility-side work can carry this above the band legitimately.',
  },
};

// --- HVAC sizing ------------------------------------------------------------
//
// A rule of thumb, and named as one. The real answer is a Manual J load
// calculation, which is exactly what the finding asks for. The arithmetic below
// only decides whether asking is worth the homeowner's breath.

const SIZING_RULE = {
  sqftPerTonLow: 350,
  sqftPerTonHigh: 700,
  citation: 'ACCA Manual J is the industry standard residential load calculation; 400-600 sq ft per ton is the '
    + 'conventional rule of thumb for existing US housing stock',
  source: 'https://www.acca.org/standards',
  note: 'Oversizing is the more common error, and it costs comfort, humidity control and compressor life rather than '
    + 'showing up on the invoice — which is why nobody catches it.',
};

// --- the federal three-day cancellation right -------------------------------

const COOLING_OFF = {
  citation: 'FTC Cooling-Off Rule, 16 C.F.R. Part 429',
  source: 'https://www.ftc.gov/legal-library/browse/rules/cooling-period-sales-made-home-or-other-locations',
  thresholdAtHome: 25,
  note: 'For a sale of $25 or more made at your home, the seller must tell you orally about the right to cancel and '
    + 'give you two copies of a dated cancellation form. The right runs to midnight of the third business day — '
    + 'Saturday counts, Sunday and federal holidays do not. It does not apply to a sale you started by going to the '
    + "contractor's own place of business.",
};

module.exports = {
  STATES,
  stateName,
  usd,
  DEPOSIT_CAPS,
  DEPOSIT_ESCROW_RULES,
  DEPOSIT_NORM,
  LICENSE_BOARDS,
  licenseBoard,
  efficiencyRegion,
  REFRIGERANT_TRANSITION,
  TAX_CREDIT_25C,
  PRICE_BANDS,
  SIZING_RULE,
  COOLING_OFF,
};
