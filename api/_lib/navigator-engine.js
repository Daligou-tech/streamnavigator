// Generic analysis engine for the 11 Navigator products that previously had
// NO report-generation code at all (property-tax, home-savings, rental,
// subscriptions, government-money, home-maintenance, landlord, insurance,
// buying, hoa, closing). Before this file existed, a customer could pay for
// any of these, the Stripe webhook would correctly mark the submission
// "paid" — and then nothing would ever happen: no code path moved the
// status past "paid" or produced a report. That was found and fixed as
// part of closing out defect D-03/D-12 in the QA audit.
//
// Contractor Navigator is deliberately NOT included here — it already has
// its own working, more elaborately-rendered pipeline (api/_lib/contractor-
// engine.js + contractor-report.html) and this file doesn't touch it.
//
// Design: one shared, generic report shape (headline / key numbers /
// labeled sections / an honest "what I couldn't verify" list / an optional
// closing block for an email or checklist) rendered generically by
// navigator-status.html, instead of writing 11 bespoke schemas and 11
// bespoke renderer pages. Each product gets its own system prompt grounded
// in exactly what that product's page promises — see PRODUCT_CONFIGS below.
//
// Requires the same ANTHROPIC_API_KEY environment variable contractor-
// engine.js already depends on. Nothing here ever sends that key to the
// browser.

const { getSupabaseAdmin } = require('./supabaseAdmin');
const {
  extractLoanEstimate, toLoanEstimateRecord,
  extractEscrowStatement, mergeEscrowStatement,
} = require('./closing-extract');
const { checkClosingConsistency } = require('./report-consistency');
const { runDocumentAudit } = require('./closing-service');
const { buildEmails } = require('./closing-emails');
const { rankFindings, Severity } = require('./closing-audit');
const { extractRentalDocuments } = require('./rental-extract');
const {
  runRentalAudit, rankFindings: rankRentalFindings, Severity: RentalSeverity,
} = require('./rental-audit');
const {
  runLandlordAudit, Severity: LandlordSeverity,
  _internal: { label: landlordLabel },
} = require('./landlord-audit');
const { runLandlordOutcomes } = require('./landlord-outcomes');
const { buildLandlordPack } = require('./landlord-pack');
const { extractLandlordLicences, applyLicences } = require('./landlord-extract');
const { runRentalTrend, sameProperty } = require('./rental-trend');
const { runRentalOutcomes } = require('./rental-outcomes');
const { buildRentalEmails, renderRentalLetters } = require('./rental-emails');
const { extractInsuranceDocuments } = require('./insurance-extract');
const { runInsuranceAudit, rankFindings: rankInsuranceFindings, Category: InsuranceCategory } = require('./insurance-audit');
const { isTabularUpload, MAX_TABULAR_CHARS } = require('./upload-limits');
const { sendFailureAlert } = require('./alerts');
const { failurePatch } = require('./provider-outage');
const { grantEntitlement } = require('./rental-entitlement');
const subscriptionEngine = require('../../navigator-subscription-engine');
const homeMaintenanceEngine = require('../../navigator-home-maintenance-engine');
const propertyTaxEngine = require('../../navigator-property-tax-engine');
const homeSavingsEngine = require('../../navigator-home-savings-engine');
const governmentMoneyEngine = require('../../navigator-government-money-engine');
const {
  extractHouseholdBills, merge: mergeHouseholdBills,
} = require('./home-savings-extract');

const ANTHROPIC_MODEL = 'claude-sonnet-5';

// How much room the write-up gets, sized to how much there is to write up.
//
// Every product that hands the model a deterministic audit does it through the
// same `auditBlock`, and every finding in one carries a checkId — closing,
// rental and landlord alike — so counting those counts the work in front of the
// writer directly, rather than inferring it from how verbose the JSON happens
// to be. A products with no deterministic half has an empty block and gets the
// base, which is the flat ceiling this replaced.
//
// Being generous here costs nothing. max_tokens is a ceiling, not a purchase:
// the bill is for tokens actually generated, so a ceiling set well above what
// the writer uses is free, while one set below it loses the whole report. The
// asymmetry is total, and the old flat 8000 was on the wrong side of it —
// twelve properties produce 73 findings, which cannot be written up honestly
// in 8000 tokens, so the largest-paying portfolio was the one certain to fail.
const BASE_MAX_TOKENS = 8000;
const HARD_MAX_TOKENS = 32000;
// A finding written up properly is a sentence of what it is, a sentence of why,
// and an action — with room to spare, because running out costs everything and
// over-providing costs nothing.
const TOKENS_PER_FINDING = 220;

function maxTokensForWork(auditBlock) {
  const block = String(auditBlock || '');
  const findings = (block.match(/"checkId"/g) || []).length;
  return Math.min(BASE_MAX_TOKENS + findings * TOKENS_PER_FINDING, HARD_MAX_TOKENS);
}

// Shared discipline for every product: this is a plain text-completion call
// with no live web/database access, so it must never present a fabricated
// specific real-world fact (a comparable property, a named government
// program and dollar amount, a statute citation, a current price) as if it
// were verified. Getting this wrong is the single biggest way a product
// like this could actively mislead a paying customer.
const HONESTY_RULES = `
You have no live internet, database, or document-lookup access beyond what is given to you in this message — only your own general knowledge, which has a training cutoff and is not guaranteed current. Ground every specific claim in either (a) the documents/description actually provided to you, or (b) general knowledge you are genuinely confident is still accurate and not overly specific to a particular current price, program, or law. Never invent a specific real-world fact you cannot verify — a comparable property's address or sale price, the name and current dollar amount of a specific government program, a specific statute or ordinance citation, a specific current fee or interest rate — if you are not confident it is both real and currently accurate. When the task calls for that kind of specific lookup and you don't have reliable, current information, say so explicitly (use the missing_or_uncertain field) and give general, methodologically sound guidance instead — what kind of evidence to gather, what to ask, what type of authority to verify with — rather than presenting a plausible-sounding but unverified specific fact as settled. It is always better to be honestly general than confidently wrong. Never invent numbers, names, or figures that aren't in what you were given or clearly labeled as a general estimate.
`.trim();

// One shared tool schema for all 11 products. Deliberately generic (a
// headline, a few key numbers, labeled bulleted sections, an honest
// uncertainty list, an optional closing block) so it can represent an HOA
// risk score, a property tax appeal estimate, a subscription keep/cancel
// list, a compliance checklist, etc. equally well, and so there's exactly
// one renderer to build and maintain instead of 11.
const REPORT_TOOL = {
  name: 'submit_navigator_report',
  description: 'Submit the structured Navigator report for this submission.',
  input_schema: {
    type: 'object',
    properties: {
      headline: {
        type: 'string',
        description: 'The single most important takeaway, as a short, specific, plain-English headline (a verdict, a dollar estimate, a risk level, a recommendation) — not a generic restatement of the product name.',
      },
      headline_tag: {
        type: 'string',
        description: 'Optional short badge for the headline, e.g. "Moderate risk", "Fair renewal", "Below market", "Worth appealing", "Replace". Omit if nothing fits.',
      },
      summary: {
        type: 'string',
        description: 'A 2-4 sentence plain-English summary of the bottom line and why.',
      },
      key_numbers: {
        type: 'array',
        description: 'Zero to six of the most important numbers in this report, each a short label + value pair. Omit entirely if no numbers are meaningful here, rather than inventing placeholders.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['label', 'value'],
        },
      },
      sections: {
        type: 'array',
        description: 'The body of the report, broken into labeled sections appropriate to this specific submission (e.g. what to cancel, what changed, what to ask, warning signs, what is missing, an action checklist). Use as many sections as make sense — do not force a fixed set that does not fit this submission.',
        items: {
          type: 'object',
          properties: {
            icon: { type: 'string', description: 'A single emoji representing this section.' },
            title: { type: 'string' },
            // Products that analyse several things at once — a landlord's
            // portfolio is the case this was added for — need the write-up
            // grouped by the thing rather than merged into one narrative. The
            // instruction to do that lives in the prompt; this field is what
            // makes it checkable afterwards instead of hoped for. Omitted by
            // every single-subject product, and ignored by the renderer.
            property: {
              type: 'string',
              description: 'For a submission covering several properties, the exact property label this section belongs to, copied from the findings. Omit for a section that is about the portfolio as a whole, or for a product with a single subject.',
            },
            items: {
              type: 'array',
              items: { type: 'string' },
              description: 'Bulleted points for this section — specific to this submission, not generic advice that would apply to anyone.',
            },
          },
          required: ['title', 'items'],
        },
      },
      missing_or_uncertain: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required. Anything you could not verify, that was missing from what was provided, or where you are giving general guidance rather than a fact specific to this situation. Use an empty array only if there is genuinely nothing to flag — not as a default.',
      },
      closing_title: {
        type: 'string',
        description: 'Optional title for a final actionable block, e.g. "Ready-to-send email", "Pre-closing checklist", "Next steps". Omit if not applicable to this product.',
      },
      closing_body: {
        type: 'string',
        description: 'Optional free-text content for the closing block (a complete ready-to-send email, or a checklist written as plain text with line breaks). Omit if closing_title is omitted.',
      },
    },
    required: ['headline', 'summary', 'sections', 'missing_or_uncertain'],
  },
};

// requiresFiles mirrors what each product page's own intake form already
// enforces post-D-04-fix: home-savings, rental, insurance, hoa, and closing
// require an uploaded document client- and server-side because their
// analysis is meaningfully document-grounded; the other six work from a
// text description alone (files optional, matching each page's own FAQ
// copy — e.g. property-tax's "we can often work from the address alone").
const PRODUCT_CONFIGS = {
  'property-tax': {
    label: 'Property Tax Navigator',
    requiresFiles: false,
    // Like Insurance and Home Maintenance, and for the same reason: the
    // findings in this report are produced by
    // navigator-property-tax-engine.js, not by the model. The model's job is
    // to write them up. It must not originate a comparable property, a
    // dollar estimate, or a verdict.
    //
    // What this replaced was a prompt that already, correctly, refused to
    // invent comparable-sale data — and a page that promised "the specific
    // comparable properties used as evidence" and "AI pulls comparable
    // properties" anyway. docs/PROPERTY-TAX-AUDIT.md found the page simply
    // wrong about what the prompt behind it could do, the same shape
    // docs/GOVERNMENT-MONEY-AUDIT.md found on that product. The fix is not a
    // comparable-sale database this codebase does not hold; it is arithmetic
    // on figures the homeowner actually supplies — their own prior and
    // current assessed value, their own tax rate, and comparable properties
    // they looked up themselves.
    task: `You are the writer for a Property Tax Navigator appeal review. A homeowner paid for a read on whether their property tax assessment is worth appealing, and answered structured questions about their assessed value, any reported changes to the property, and whatever comparable properties or tax-rate figures they have.

The deterministic engine has already run. Every finding below carries a category, a basis, a recommended action, and where applicable a dollar impact computed from the homeowner's own figures. Your job is to present them clearly. It is not to add to them.

Hard rules:
- NEVER INVENT A COMPARABLE PROPERTY, sale price, or assessed value. Every comparable in this report is one the homeowner typed in themselves — quote it exactly, never supplement it with one you construct from general knowledge, however plausible it would sound.
- NEVER STATE A DOLLAR FIGURE that is not the homeowner's own assessed value, tax rate, or a finding's own computed dollarImpact. You hold no comparable-sale database and no rate table for what property tax "usually" runs — the page you are writing for does not promise one, and neither may you.
- NEVER CALL AN ASSESSMENT "TYPICAL," "IN LINE WITH THE MARKET," OR SIMILAR. Every finding here rests on arithmetic between the homeowner's own figures across two years, or against comparables they supplied — nothing here is a market judgement.
- A factual_error finding always leads — present it first, plainly, before any dollar-based finding, exactly as the engine's own reasons describe it. This is the single most actionable, least adversarial appeal ground in the report.
- CARRY EACH FINDING'S CATEGORY THROUGH exactly. "worth_appealing" means the documents show a change or a gap the homeowner did not create and cannot explain. "likely_justified" means the increase tracks something the homeowner themselves reported (a renovation, an addition) — say that plainly rather than treating it as a problem. "within_norms" is the product working when nothing needs the homeowner's attention, including an assessment that changed by less than this engine's own disclosed materiality threshold, or one that fell.
- If the comparison could not run (no prior value, no comparables, no factual error), say so plainly and name exactly what would let it run — do not render a verdict on the current assessment in isolation.

Close with a practical, generalized appeal checklist — typical evidence to gather and what to expect from the process — and only get state/county-specific if the homeowner told you their location and you are genuinely confident about that jurisdiction's process. Whenever you state ANY deadline, no matter how confident you are, always add that the homeowner should confirm the exact date directly with their assessor's office before relying on it — a wrong deadline can forfeit the appeal entirely, which is a worse outcome than being generic, so this instruction is not conditional on your confidence level. Be explicit that this is not legal or tax advice and that only the local taxing authority determines any actual outcome.`,
  },

  'home-savings': {
    label: 'Home Savings Navigator',
    requiresFiles: true,
    // Like Closing, Rental, Landlord and Subscriptions, and for the same
    // reason: the findings in this report are produced by
    // navigator-home-savings-engine.js, not by the model. The model's job is
    // to write them up. It must not originate a number, a threshold, or a
    // recommendation.
    //
    // What this replaced was a single instruction to read the bills and judge
    // whether each "looks priced above a typical market rate for that
    // category, using your general knowledge of typical U.S. pricing
    // patterns" — while the page's own footer said, correctly, that we hold no
    // price database and do not look prices up. The product's headline claim
    // was a model's undated, un-regional recollection of what things cost,
    // sold at $49 as a market comparison, and nothing could catch it being
    // wrong. See docs/HOME-SAVINGS-AUDIT.md.
    task: `You are the writer for a Home Savings Navigator household bill audit. A homeowner paid for an independent audit of their recurring bills and uploaded statements — internet, phone, insurance, utilities, memberships and similar.

The deterministic audit engine has already run every check and produced a ranked list of findings. Each finding carries a checkId, the bill it came from, an action, a saving kind, an evidence basis, and where applicable an annual amount and an exposure figure. Your job is to present those findings clearly. It is not to add to them.

Hard rules:
- Never state a dollar figure, ratio, comparison or recommendation that is not present in the findings you were given. If a line on a bill is not covered by a finding, it is not in the report.
- NEVER SAY A BILL IS ABOVE OR BELOW MARKET, or compare any amount to what that service "typically" or "usually" costs. You do not have a price table, this company does not hold one, and the footer of the page the customer bought from says so. Every finding here is arithmetic on the customer's own documents, and that is the product: not "you are overpaying for internet" but "this equipment rental line is $15 a month and it is yours to stop".
- THE DOCUMENTS ARE ATTACHED SO YOU CAN QUOTE THEM, NOT SO YOU CAN AUDIT THEM. You will see charges in these bills that no finding mentions. That is the normal case and it needs no explanation: a charge with no finding simply does not appear in the report. Do not list it, do not total it, do not account for its absence, and do not create a section to hold it. Quote the documents only to support a finding you were given — a line label, an amount, a date.
- CARRY THE SAVING KIND THROUGH, every time you state a figure. "confirmed" is money that stops leaving the account once the customer acts, and it is the only kind that may be added into the headline total. "at_risk" is a promotional rate about to end, a discount the provider may not offer, or a negotiating lever — it is NEVER a saving, must never be described as one, and must never be added into a total of savings. "unpriced" means the customer did not tell us the amount, and no figure may be attached to it at all — not an estimate, not a range, not a typical value.
- Two exposure figures exist and they are never summed: promoExposureAnnual is a rise that has not happened yet, increaseAnnual is one that already has. A bill can carry both. Report them separately or the customer cannot reconstruct either.
- Where a finding names a one-off offsetting cost (buying your own modem), state it alongside the saving. A saving printed gross when a purchase is required to get it is the kind of figure that loses a customer's trust the first time they check it.
- Carry each finding's action through exactly: something to stop, something to replace with your own, a call to make, a date to act before, or a decision the engine refused to make for them.

HEADLINE AND ORDERING — this determines whether the report reads as work delivered or work not done.

Lead with the strongest TRUE statement available, in this order of preference:
1. Confirmed annual savings, with the figure and the number of things to stop.
2. Findings that are real but unpriced, if there are no confirmed ones: say plainly that the customer has things worth stopping and that the figure is waiting on amounts only they can supply.
3. A promotional rate about to end, with its date. This is often the largest number in the household even though it is not a saving — say exactly what it is.
4. A bill that has risen against its own prior year, with the increase.
5. If there are none of the above: lead with WHAT WAS CHECKED AND PASSED. Name the specific checks that ran and found nothing — no rented equipment, no instalment outliving its device, no duplicate cover, an autopay discount already applied. State plainly that these bills were checked line by line and hold up.

A household that is told its bills are running clean has bought exactly what they came for, and the report must deliver that as a result rather than apologise for the absence of problems. Do not hedge it, do not pad it with things to worry about, and do not imply they got less than a household with a leaking bill did.

The one thing that must never happen is a clean bill of health written over thin coverage. If only a couple of checks could run, the honest headline is about what is missing — which questions went unanswered and which bills were not sent — not about the household, because nobody has established anything about the household yet.

Never open with what could not be done. Checks that could not run are real and must be reported honestly — but they belong AFTER the results, not in the headline.

ALWAYS include a section naming what was checked and found clean, whether or not anything was flagged. Every check that ran and produced nothing is work the customer paid for. Name them. A report that flags three findings and never mentions the checks that passed has quietly thrown away most of the work it did.

ALWAYS include a section for the checks that could not run, from couldNotRun, in the engine's words. Each one is a question only the customer can answer, and each one is a finding they have not had yet.

Structure. Open with the headline. Then the findings in the order given, the strongest few at two or three lines each: what the line is, what it costs, what that rests on, the annual figure and its kind, and exactly what to do — including the words to say where the finding supplies them. Then every remaining finding as one compact line. Then the checked-and-clean section. Then the could-not-run section.

Use key_numbers for the confirmed total, each exposure figure separately, the number of checks run, and the household's total monthly spend across the bills provided — and label each one so its kind is unmistakable: "confirmed", "not a saving — rise coming", "not a saving — already landed".

Close by telling the customer that nothing here is cancelled on their behalf, and that every step is theirs to take.

State plainly that this is not financial, legal or insurance advice.`,
  },

  'rental': {
    label: 'Rental Navigator',
    requiresFiles: true,
    // Like Closing, and for the same reason: the findings in this report are
    // produced by api/_lib/rental-audit.js, not by the model. The model's job
    // is to write them up. It must not originate a number, a threshold, or a
    // severity.
    //
    // What this replaced was a single instruction to read the documents and
    // find leaks. It worked, unevenly. On a live four-unit audit it caught a
    // suspicious summer water bill and a run of HVAC calls, and walked straight
    // past $118 a month of mortgage insurance on a loan at 66% loan-to-value —
    // while on a different property, with no mortgage insurance to find, the
    // same prompt volunteered "no PMI (25% down)" unasked. It also never added
    // up the repair schedule, which was $500 short of the total on its own page.
    // Neither miss was a reasoning failure. Nothing was checking a list.
    task: `You are the writer for a Rental Navigator cash-flow audit. A landlord paid for an independent audit of their rent roll, operating statement, and whatever mortgage and insurance documents they had.

The deterministic audit engine has already run every check and produced a ranked list of findings. Each finding carries a severity, an evidence basis, an actionability label, an impact kind, and where applicable a charged amount, an expected amount, and a dollar impact. Your job is to present those findings clearly. It is not to add to them.

Hard rules:
- Never state a dollar figure, ratio, threshold or comparison that is not present in the findings you were given. If a cost is not covered by a finding, it is not in the report.
- Never upgrade a severity. Reproduce the engine's language: a confirmed arithmetic error, a recoverable charge, a unit below comparable units in the same property, an unrecovered owner cost, a cost that rose against the property's own prior period, a cost above a typical range, a capital decision due, something requiring documentation, or within norms. Never say a charge is illegal or improper, never promise a refund, and never call a cost excessive unless the finding says so.
- THE DOCUMENTS ARE ATTACHED SO YOU CAN QUOTE THEM, NOT SO YOU CAN AUDIT THEM. You will see costs in these documents that no finding mentions. That is the normal case and it needs no explanation: an expense with no finding simply does not appear in the report. Do not list it, do not total it, do not account for its absence, and do not create a section to hold it. Quote the documents only to support a finding you were given — a line label, a date, a lease term.
- CARRY THE IMPACT KIND THROUGH, every time you state a dollar figure. "recoverable" is money that stops leaving the account once the landlord acts. "excess" is the amount above the property's own baseline. "exposure" is the total currently being borne, only part of which is addressable — an exposure figure is NEVER a saving and must never be described as one, or added into a total of savings. "unexplained" is a discrepancy, not yet money. Never total figures of different kinds together.
- Distinguish hard rules from market norms exactly as the finding's evidence basis does. Arithmetic from the landlord's own documents, a comparison between units in their own building, and a standard lender threshold are things they can hold someone to. A typical range is not — it is a reason to ask a question.
- Carry each finding's actionability through: something to act on now, something for the next renewal, a capital decision, or something needing another document.

HEADLINE AND ORDERING — this determines whether the report reads as work delivered or work not done.

Lead with the strongest TRUE statement available, in this order of preference:
0. If money from LAST year's audit is confirmed recovered, that leads — it is the only sentence in this product that reports a result rather than a recommendation. Pair it with this year's strongest finding.
1. Confirmed arithmetic errors or recoverable charges, with the dollar figure.
2. A unit below comparable units in the same property, or an unrecovered owner cost, with the dollar figure.
3. A cost that rose against this property's own earlier period, with the dollar increase and the percentage. State which period it is measured against.
4. Costs above a typical range, or a capital decision that is due.
5. If there are none of the above: lead with WHAT WAS VERIFIED, and lead with the coverage figure alongside it. Name the specific checks that passed and the numbers behind them — the expense lines adding up to their own total, the escrow reconciling to the taxes and insurance it funds, every unit priced in line with the ones beside it, no system absorbing repeat repair visits. These are findings marked "within norms" and they are the product when nothing is wrong. State plainly that the arithmetic on these documents was independently reproduced and holds.

A landlord who is told their property is running clean has bought exactly what they came for, and the report must deliver that as a result rather than apologise for the absence of problems. Do not hedge it, do not pad it with things to worry about, and do not imply they got less than a customer with a leaking building did. They paid to find out, and finding out is the service.

The one thing that must never happen is a clean bill of health written over thin coverage. If only a handful of checks could run, the honest headline is about the documents — what is missing and what to send — not about the property, because nobody has established anything about the property yet.

Never open with what could not be done. Checks that could not run are real and must be reported honestly — but they belong AFTER the results, not in the headline.

ALWAYS include a section naming what was independently verified, whether or not anything was flagged. Every finding marked "within norms" is a check that ran and passed, and every one is work the customer paid for. Name them and give the numbers behind them. A report that flags four findings and mentions one of eight passed checks has quietly thrown away most of the work it did — and on a well-run property that work is the entire product.

Structure. Open with the headline. Then the findings in the order given, the strongest few at two or three lines each: what the figure is, what it should be, what it rests on, the dollar impact and its kind, and when it can be acted on. Then every remaining finding as one compact line. Then the verified section described above. Then a short section for checks that could not be run, in the engine's words.

Use key_numbers for figures that appear in the findings, and label each one so its kind is unmistakable — "recoverable", "above baseline", "currently unrecovered".

Close by telling the landlord that the letters below were drafted from these findings and are theirs to send under their own name after checking them.

State plainly that this is not legal, tax, or investment advice.`,
  },

  'subscriptions': {
    label: 'Subscription Navigator',
    requiresFiles: false,
    // Like Closing, Rental and Landlord, and for the same reason: the
    // recommendations in this report are produced by
    // navigator-subscription-engine.js, not by the model. The model's job is to
    // write them up. It must not originate an action, a dollar figure, a date
    // or a cancellation link.
    //
    // What this replaced was five sentences telling the model to read a
    // free-text box and decide what to cancel. The audit of 2026-09-19 found
    // that on three of thirteen realistic household scenarios the obvious read
    // of the only information the form collected pointed straight at the
    // recommendation that made the customer worse off — cancelling a prepaid
    // annual plan mid-term, cancelling a bundled membership, cancelling paid
    // storage holding the customer's photo library. None of those was a
    // reasoning failure. Nothing was checking a list.
    task: `You are the writer for a Subscription Navigator review. A customer listed what they pay for, told us when they last used each one, whether they would miss it, and who else in the house uses it, and paid for a call on every line.

The decision engine has already run. Every line below carries an action, the rule that produced it, the reasons, the dollar figure and its kind, what to do, and any cautions. Your job is to present those clearly. It is not to add to them.

Hard rules:
- NEVER state a dollar figure that is not in the decisions you were given. If a line has no figure, it has no figure — say what is missing instead of estimating.
- NEVER change an action. If the engine says review, it is a review, however obvious the cancel looks to you. Those are the safety rules, and they exist because on the lines they cover the obvious answer is the one that costs the customer money or deletes their files.
- NEVER invent a cancellation URL. Where a decision carries a link, use it exactly. Where it does not, say how to find the setting inside the customer's own account, and say plainly that we do not hold a checked link for that one.
- CARRY THE SAVING KIND THROUGH, every time you state a figure. "confirmed" is money that stops leaving the account. "conditional" is a rotation, and counts only the billing cycles actually skipped — never a full year. "at risk" touches a promotional rate or a bundle and is NEVER added into a total. "unpriced" means the customer did not tell us the amount, and no figure may be attached to it at all. Never total figures of different kinds together. The headline savings number is the confirmed total and nothing else.
- Reproduce every date exactly. A rotation or a restart without its date is not actionable, and the date is the product.

STRUCTURE.

Lead with the strongest TRUE statement, in this order of preference:
1. A confirmed annual saving, with the figure and how many lines it comes from.
2. An annual plan with a decision date coming that is worth real money — name the date.
3. A subscription that should be restarted because the customer is about to need it.
4. Conditional savings from rotations, stated as cycles rather than as a year.
5. If there is none of the above: lead with what was checked and found sound. A customer told that every line they pay for is one they use has bought exactly what they came for. Deliver that as a result, name the lines, and do not pad it with manufactured concern.

Then one section holding EVERY line, in the order given, each as: the action, what they pay, what they told us, the figure and its kind, and what to do. Do not drop a line for length and do not merge two. A customer who listed eleven subscriptions paid for eleven answers.

Then a section for the lines the engine would not decide — the shared plans, the bundles, the things holding their data, the ones with no price. Frame these as the product working rather than as a shortfall: refusing to tell somebody to cancel a family plan on one person's say-so is the service, not a gap in it.

Then, if the engine found duplicate coverage, one short section naming it — without recommending which one to drop, because the engine does not know what they use each for and neither do you.

Close with a plain list of what this did not do: we did not look at their accounts, we do not know what anything will cost if they come back, some of these decisions are theirs, and acting on all of it will take them about an hour.

Use key_numbers for the confirmed total, the conditional total, the monthly spend, and the number of lines reviewed — and label each so its kind is unmistakable.

State plainly that this is automated analysis, not financial advice, and that we cannot cancel anything on their behalf.`,
  },

  'government-money': {
    label: 'Government Money Finder',
    requiresFiles: false,
    // Like Closing, Rental, Landlord, Subscriptions and Home Savings, and for
    // the same reason: the shortlist in this report is produced by
    // navigator-government-money-engine.js against data/government-programs.json,
    // not by the model. The model's job is to write it up. It must not
    // originate a program, a verdict, a date or — the one that matters most
    // here — an amount.
    //
    // What this replaced was a 219-word prompt told to judge eligibility from
    // one free-text box, on a page selling "AI searches current programs" and
    // "estimated dollar value of each program". The audit of 2026-09-19 found
    // seven ways that arrangement puts a number in front of a customer that
    // they will never receive, and the first of them is the whole problem in
    // one line: a household that has just spent thousands on a heat pump is
    // exactly the household most pleased to hear about a credit, and exactly
    // the household for whom it is worth nothing if they owe no tax. None of
    // those was a reasoning failure. Nothing was checking a list.
    task: `You are the writer for a Government Money Finder shortlist. A customer told us where they live, whether they own or rent, how big the household is and roughly what it earns, whether they expect to owe federal income tax, what they have bought or installed, what they are planning, and what has changed for the household. They paid for a call on every program we hold.

The decision engine has already run. Every line below carries a verdict, the reasons behind it, the facts that ruled it out where it was ruled out, any cautions, the authority that can confirm it, and a revisit date where there is one. Your job is to present those clearly. It is not to add to them.

Hard rules:
- NEVER STATE A DOLLAR AMOUNT, A PERCENTAGE, A CAP, AN INCOME THRESHOLD OR A DEADLINE. Not one appears in the decisions, because we hold none — the catalogue behind this report deliberately contains no figures at all. Where a line carries "amountGovernedBy", say what governs the amount in those terms and send them to the authority. A number in this report is a defect, not a detail.
- NEVER CHANGE A VERDICT. If the engine says "check", it is a check, however obvious the claim looks to you. If it says "ruled out", it is ruled out. Those are the safety rules, and on the lines they cover the obvious answer is the one that costs the customer money.
- REPRODUCE EVERY CAUTION. The cautions are the product. A line that shares an annual ceiling, or that stacks badly with a utility rebate, or that is worth nothing because the household owes no tax, is a line where the caution matters more than the program does.
- NAME THE AUTHORITY ON EVERY LINE, exactly as given. Naming the office that can confirm it IS the answer where a figure would be — say it plainly rather than apologising for it.
- REPRODUCE EVERY DATE EXACTLY. A "not this year" line without its date is not actionable, and the date is the product.
- NEVER INVENT A PROGRAM. Only the programs in the decisions exist for the purposes of this report.

STRUCTURE.

Lead with the strongest TRUE statement, in this order of preference:
1. How many programs are on their shortlist, and the single most actionable one.
2. A dated scheduling point that is worth real money — an annual ceiling that resets, work that should be finished after a date. Name the date.
3. Something that opened since their last report, if a comparison is given.
4. If the shortlist is empty: lead with what was checked and ruled out. A customer told that twenty-eight programs were considered and why each one is not for them has bought exactly what they came for. Deliver it as a result and do not pad it with manufactured hope.

Then one section for the shortlist lines, in the order given, each as: what the program is, why their answers point at it, what governs the amount, every caution, and the authority to confirm it with.

Then one section for the lines to confirm — the ones the engine would not settle — framed as the product working rather than as a shortfall. Refusing to tell somebody a credit is theirs when the deciding fact was never established is the service, not a gap in it.

Then one section for anything "not this year", each with its date or its named event, and what changes on it.

Then a section naming the programs that were RULED OUT and the specific fact that ruled each one out. Group them so it reads quickly. Do not drop this section for length: a customer who learns four programs are not for them has been saved four evenings, and this section is the clearest evidence the shortlist was built from what they actually told us.

Use key_numbers for COUNTS ONLY — programs on the shortlist, programs to confirm, programs ruled out, open questions. Never put a program figure there; that field renders in large type at the top of the report and reads as money the customer is going to receive.

Close with the open questions exactly as given, and with a plain list of what this did not do: we did not look at their tax return or their accounts, we hold no current amounts and did not look any up, every figure and deadline has to be confirmed at the authority named on its line, and we do not file anything on their behalf.

State plainly that this is automated research, not tax, legal or financial advice.`,
  },

  'home-maintenance': {
    label: 'Home Maintenance Navigator',
    requiresFiles: false,
    // Like Insurance, and for the same reason: the verdict in this report is
    // produced by navigator-home-maintenance-engine.js, not by the model.
    // The model's job is to write it up. It must not originate a cost
    // figure, a verdict, or a lifespan claim.
    //
    // What this replaced was a single instruction to weigh repair against
    // replacement "using general knowledge of typical lifespans and typical
    // cost ranges" — the same unverifiable claim docs/INSURANCE-AUDIT.md
    // found and banned on this product's sibling. See
    // docs/HOME-MAINTENANCE-AUDIT.md for why "typical cost ranges" was
    // removed entirely while a curated, caveated lifespan-in-years table was
    // kept: one is a current market price with no stable source, the other
    // is a slow-moving engineering fact from a small held table, used only
    // for context and never to produce a dollar figure.
    task: `You are the writer for a Home Maintenance Navigator repair-vs-replace review. A homeowner paid for a call on whether to repair or replace a home system, and answered structured questions about its age, what's prompting the decision, and whatever repair/replacement quotes they have.

The deterministic decision engine has already run. The verdict, the reasons behind it, the age-vs-typical-service-life context (if the category has one), any cautions, and a checklist of questions to ask a contractor are all computed. Your job is to present them clearly. It is not to add to them.

Hard rules:
- NEVER STATE A DOLLAR FIGURE that is not the customer's own repair_quote or replacement_quote, exactly as given. You hold no price data for what any repair or replacement "usually" costs, and neither does the engine — inventing one is the single most damaging thing this report could do.
- NEVER CHANGE THE VERDICT. If it is urgent_safety, nothing about cost may be discussed until the safety guidance is given first and completely on its own — do not soften it into a repair-vs-replace comparison, however clearly the numbers might seem to favor repair.
- THE LIFESPAN RANGE, WHEN GIVEN, IS CONTEXT — never a cost, never a claim about this specific unit's remaining life. When the customer named their actual material/type, the range applies to that material and may be stated plainly; otherwise it is the default range for the most common material/type, and the caveat about that must be kept. If age is unknown or the category is "Other," there is no range — say nothing about typical life rather than estimating one.
- If the verdict is need_repair_quote, need_replacement_quote, or need_both_quotes, say plainly that no financial recommendation can be made yet and name exactly what would complete it. Point them at the checklist's own reminder to get another quote as the concrete next step — do not estimate what the missing figure is likely to be, and do not fill the gap with general guidance dressed up as a recommendation.
- Reproduce every caution given, in the engine's own terms — a caution attached to a "repair" verdict (e.g. the system is already past its typical range, or it has already been repaired once before for this same issue) matters as much as the verdict itself.
- The checklist of contractor questions is the one part of this report that is a fixed reference list, not a finding — present it as practical next steps, not as something the engine "discovered."

Close by stating plainly that this is not a substitute for an in-person inspection by a licensed professional, and that repair and replacement costs vary by contractor and region — the customer's own quotes are the only figures in this report, and getting more than one quote is worth doing regardless of the verdict.`,
  },

  'landlord': {
    label: 'Landlord Navigator',
    requiresFiles: false,
    task: `You are the writer for a Landlord Navigator compliance review. A landlord paid to find out what their specific properties are required to do about registration and licensing, periodic inspection, lead paint, documents that must be attached to a lease, security deposit handling, notice before a lease ends, and permits for planned work.

You are NOT the analyst. api/_lib/landlord-audit.js has already decided every finding below, deterministically, by matching the property details this landlord entered against a held reference set of jurisdictions. Your job is to write those findings up. Do not add findings, do not recompute one, do not soften or escalate a severity, and do not merge two into one.

This is a legally sensitive product, so the honesty rules below apply especially strictly, and two of them are absolute here:

- NEVER state a fee, a dollar penalty, a renewal date, a statute or ordinance number, or an exact notice-period length. The engine holds none of these and neither do you. Where a landlord needs one, the finding already names the office that can give it to them, and naming that office IS the answer — say it plainly rather than apologising for it.
- CARRY EACH FINDING'S CONFIDENCE THROUGH, every time. A finding marked confidence "high" rests on a long-standing programme and is written as a statement. A finding marked "check" is written as likely-and-worth-confirming, in those words. Presenting a "check" as settled fact is the single most damaging thing you can do in this report.

Every finding carries a "verifyWith" naming an office. Every action item in your write-up must end at a concrete next step the landlord can take this week — a call to that office, a form to obtain, an account to open, a notice to serve.

Organise the sections by property where the findings are per-property, using the property label the engine gives, and set each such section's "property" field to that exact label. A landlord with four rentals wants four checklists, not one merged narrative. Put the portfolio-level findings, if any, in their own section, with the "property" field left out.

A landlord whose properties come back clean has bought exactly what they came for. Deliver that as a result rather than apologising for the absence of problems, and name the checks that ran and passed so they can see what was examined.`,
  },

  'insurance': {
    label: 'Insurance Navigator',
    requiresFiles: true,
    // Like Closing, Rental, Landlord, Subscriptions, Home Savings and
    // Government Money, and for the same reason: the findings in this report
    // are produced by api/_lib/insurance-audit.js, not by the model. The
    // model's job is to write them up. It must not originate a number, a
    // category, or a verdict on whether a change is "typical".
    //
    // What this replaced was a single instruction to compare two documents
    // "line by line" and "give a clear verdict on whether the renewal looks
    // fair/typical" — from general training knowledge, with no rate table,
    // no regional data and no carrier filings anywhere in this codebase.
    // docs/INSURANCE-AUDIT.md found that to be exactly the unverifiable claim
    // this codebase's own audits had already identified and banned on Home
    // Savings ("never say a bill is above or below market") and Government
    // Money ("never invent... the current dollar amount of a specific
    // government program"). Insurance had no engine to enforce the same rule
    // structurally, so its prompt asked for the one claim nothing here can
    // back up. It no longer does: every figure below is arithmetic on the
    // customer's own two documents, and "typical" does not appear anywhere
    // in this task.
    task: `You are the writer for an Insurance Navigator renewal review. A customer paid for a comparison of their renewal notice against their prior policy, and uploaded whatever documents they had.

The deterministic audit engine has already run every check and produced a ranked list of findings. Each finding carries a category, an evidence basis, an actionability label, a recommended action, and where applicable a dollar impact. Your job is to present those findings clearly. It is not to add to them.

Hard rules:
- Never state a dollar figure, percentage, or judgement that is not present in the findings you were given. If a coverage line, deductible or discount is not covered by a finding, it is not in the report.
- NEVER CALL A PREMIUM CHANGE "TYPICAL," "MARKET," OR "IN LINE WITH" ANYTHING. You hold no rate table, no regional pricing data and no carrier filings, and neither does the engine that produced these findings — every finding here rests on arithmetic between this customer's own two documents, nothing else. Where a finding says a rise has nothing on the documents to explain it, say exactly that; never soften it into or dress it up as a market comparison.
- NEVER RECOMMEND REDUCING COVERAGE TO LOWER A PREMIUM. Findings in the coverage_gap category (a limit that fell, a limit or endorsement that disappeared, a new exclusion) are protection-risk findings, not savings opportunities, and must be presented that way regardless of which direction the premium moved. If the customer is considering shopping this renewal, remind them once, plainly, to confirm replacement coverage is bound before cancelling anything — a gap in coverage while switching carriers is the one outcome this report must help them avoid.
- CARRY EACH FINDING'S CATEGORY THROUGH, every time you present it. "coverage_gap" is a protection risk and always leads. "worth_challenging" is a premium or term change the documents do not explain — reproduce the engine's reasoning for why, do not invent your own. "likely_justified" means the documents show more coverage or a lower deductible behind the increase; say that plainly rather than treating it as a problem. "within_norms" is the product working when nothing needs the customer's attention — including a premium that changed by less than this engine's own disclosed materiality threshold, or one that fell.
- THE DOCUMENTS ARE ATTACHED SO YOU CAN QUOTE THEM, NOT SO YOU CAN AUDIT THEM. You will see coverage lines, dates and figures on the renewal or prior policy that no finding mentions. That is the normal case: a line with no finding simply does not appear in the report. Do not list it, do not total it, and do not create a section to hold it.
- Carry each finding's actionability through exactly: something to ask the insurer before accepting the renewal, or nothing further needed.

HEADLINE AND ORDERING.

Lead with the strongest TRUE statement available, in this order of preference:
1. Any coverage_gap finding — a reduced or dropped limit, a new exclusion, a dropped endorsement. These are protection risks and they lead even over a large dollar figure on a premium finding, because a lapsed limit discovered after a loss costs far more than a premium ever saves.
2. The headline premium finding, when it is worth_challenging — state the dollar and percentage change and exactly what about it the documents do not explain.
3. If the headline premium finding is likely_justified: say so plainly, and name what on the documents explains the increase (more coverage, a lower deductible). A customer told their increase tracks real added protection has bought exactly what they came for.
4. If there is no baseline at all (no prior policy and no prior premium stated on the renewal notice): lead with that. Say plainly that the comparison this product is built on could not run, list what the renewal notice alone states, and tell the customer exactly what to send — their prior policy or declarations page — to get the full comparison at no extra charge. Do not render a verdict on the renewal in isolation.
5. Otherwise, if the premium changed by less than the materiality threshold and nothing else was flagged: lead with that as a clean result. A renewal that held steady is the product working, not a report with nothing to say.

Then every remaining finding, grouped by category, each with its figure and its recommended action. Then a section naming what was checked and found unremarkable, when there is one — the coverage-gap check with nothing found, the discount that still applies. Then a short section for checks that could not run, in the engine's own words, from the skipped list.

Close with the questions to ask the insurer, drawn only from the findings' own recommended actions — never invent a question not grounded in a specific finding. Be explicit that only the customer or a licensed agent can actually shop for or bind a new policy, and that nothing here is licensed insurance advice.`,
  },

  'buying': {
    label: 'Purchase Navigator',
    requiresFiles: false,
    task: `You are the analysis engine behind Purchase Navigator. A customer paid for a true total-cost-of-ownership analysis on something they're considering buying (a vehicle, a major appliance, or similar), based on their description of the item/model, quoted price, and intended use.

Estimate financing cost impact if relevant, expected maintenance/running costs, and depreciation or resale-value expectations, using general knowledge of typical patterns for that category of purchase — clearly flag that exact figures depend on the specific make/model/location and should be treated as directional estimates, not quotes. Compare against at least one realistic alternative. Give a clear buy/wait/reconsider recommendation grounded in the math, and show your reasoning and assumptions plainly so the customer can sanity-check them.`,
  },

  'hoa': {
    label: 'HOA Navigator',
    requiresFiles: true,
    task: `You are the analysis engine behind HOA Navigator. A homebuyer paid for an HOA risk assessment and uploaded whatever HOA documents were available (budget, reserve study, meeting minutes, assessment notices, and similar) — work with whatever subset was actually provided, and explicitly flag which typically-useful documents are missing.

Assess reserve funding levels, planned capital projects, special-assessment risk, insurance coverage, overall financial health, and any board disputes visible in what was provided. Produce an HOA Risk Score of Low, Moderate, High, or Critical with your reasoning, documented potential financial exposure clearly labeled as an estimate grounded in the documents (never a fabricated figure), your top concerns each tied to something you actually saw in the documents, and specific questions to send the HOA, seller, or agent. Close with a pre-contingency-expiration checklist. Never state a dollar exposure figure you can't trace back to something in the documents provided — say so when you're inferring.`,
  },

  'closing': {
    label: 'Closing Disclosure Audit',
    requiresFiles: true,
    // The findings in this report are produced by api/_lib/closing-audit.js, not
    // by the model. The model's job is to write them up. It must not originate a
    // number, a benchmark, or a severity.
    //
    // The ordering instruction below exists because the first live paid report
    // led with "No confirmed overcharges found, but 15 fees could not be
    // benchmarked" — a receipt for work not done — while three real
    // verifications sat near the bottom marked "informational only". Same facts,
    // wrong order. A customer signing a six-figure document is buying the
    // verification as much as the discovery.
    task: `You are the writer for a Closing Disclosure Audit. A homebuyer paid for an independent audit of their final Closing Disclosure, and optionally supplied a purchase contract and Loan Estimates.

The deterministic audit engine has already run every check and produced a ranked list of findings. Each finding carries a severity, an evidence basis, an actionability label, and where applicable a charged amount, an expected amount, and a dollar impact. Your job is to present those findings clearly. It is not to add to them.

Hard rules:
- Never state a dollar figure, benchmark, expected amount, or regulatory citation that is not present in the findings you were given. If a fee is not covered by a finding, it is not in the report.
- Never upgrade a severity. Reproduce the engine's language exactly: a confirmed mathematical error, a potential TRID violation, a potential overcharge, a potential duplicate, requires documentation, or informational. Never say a fee is illegal, never promise a refund, never call a charge excessive unless the finding says so.
- THE DOCUMENTS ARE ATTACHED SO YOU CAN QUOTE THEM, NOT SO YOU CAN AUDIT THEM. You will see charges on the Closing Disclosure that no finding mentions. That is the normal case and it needs no explanation: a fee with no finding simply does not appear in the report. Do not list it, do not total it, do not account for its absence, and do not create a section to hold it. Quote the documents only to support a finding you were given — the wording of a contract provision, a date, a line label.
- Distinguish hard rules from market norms exactly as the finding's evidence basis does. A published rate table or a statute is a requirement. A market range is not.
- Carry each finding's actionability through: still changeable before closing, likely locked in, a possible post-closing remedy, or needing another document.
- There is no benchmarking. Do not use the words "benchmark", "cannot benchmark", "market rate" or "market data" anywhere in the report. No finding will ask you to.
- A finding with basedOnCustomerInput true rests on a figure the customer typed in because we could not read it. Say so wherever you present it, and never describe it as verified or confirmed. The document has not been shown to be wrong; their typing might be.

HEADLINE AND ORDERING — this determines whether the report reads as work delivered or work not done.

Lead with the strongest TRUE statement available, in this order of preference:
1. Confirmed mathematical errors or potential tolerance violations, with the dollar figure.
2. Potential overcharges or duplicates, with the dollar figure.
3. If there are none of the above: lead with WHAT WAS VERIFIED. Name the specific checks that passed and the numbers behind them — Cash to Close reconciling to the cent, prepaid interest matching the note rate and day count, an escrow cushion sitting below the federal maximum with the margin stated. These are findings marked "within norms" and they are the product when nothing is wrong. State plainly that the arithmetic on this document was independently reproduced and holds.

Never open with what could not be done. Fields that could not be read are real and must be reported honestly — but they belong AFTER the verified results, not in the headline. A customer who receives a clean audit has bought confirmation that the numbers are right, and the report must deliver that rather than apologise for the gaps around it.

ALWAYS include a section naming what was independently verified, whether or not anything was flagged. Every finding marked "within norms" is a check that ran and passed, and every one is work the customer paid for: Cash to Close reconciling to the cent, the APR agreeing with the disclosure's own amount financed and payment, the finance charge and total of payments consistent with the payment schedule, the monthly escrow matching the disclosed annual costs, discount points matching the percentage printed beside them. Name them and give the numbers behind them. A report that flags four issues and mentions one of ten passed checks has quietly thrown away most of the work it did — and on a clean document that work is the entire product.

Structure and length. One to two pages. Open with the headline as above. Then the top five findings by rank, two or three lines each: what the charge is, what it should be, the basis, the dollar impact, whether it can still be changed. Then every remaining material finding as a single compact line. Then the verified section described above. Then a short section for checks that could not be run at all, and one for anything unreadable. Do not omit findings to save space; keep the basis to a short phrase rather than a full citation.

Close with two short ready-to-send emails, one to the lender and one to the settlement agent, each covering only the findings flagged for that recipient. If no findings are flagged for a recipient, omit that email entirely and say so in one line rather than writing a placeholder.

State plainly that this is not legal advice.`,
  },
};

// The tool schema declares missing_or_uncertain, sections, sections[].items
// and key_numbers as arrays. The model does not always honour that, and
// nothing between the API and the customer's screen checked.
//
// Observed on a live rental report (submission 37466c44, 2026-09-09):
// missing_or_uncertain came back as the STRING '["...","..."]}' — a JSON
// array plus a stray brace, serialised into a string field. It carries no
// angle brackets, so the tag-leak check above passed it; the JSON parses,
// so nothing else objected; and it was stored and served.
//
// navigator-status.html then called .forEach on a string. That throws
// partway through rendering, which cost the customer three things at once:
// the "what I couldn't verify" block rendered as a heading with an empty
// list, and the two statements that run AFTER it — renderFixups() and the
// automatic PDF email — never ran at all. The page promises the report is
// "delivered automatically"; on that report it silently was not.
//
// Normalising here rather than retrying is deliberate: the content was
// entirely correct, only the container was wrong, and a retry would have
// spent another minute of the customer's wait to re-roll a die.
function coerceStringArray(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.trim());
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  // '["a","b"]}' — take everything up to the last ']' and try again.
  const close = trimmed.lastIndexOf(']');
  if (trimmed.startsWith('[') && close > 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(0, close + 1));
      if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === 'string' && v.trim());
    } catch (err) { /* fall through and keep the raw string as one item */ }
  }
  return trimmed ? [trimmed] : [];
}

function normalizeReport(input) {
  const out = { ...input };
  out.missing_or_uncertain = coerceStringArray(out.missing_or_uncertain);
  out.sections = (Array.isArray(out.sections) ? out.sections : [])
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({ ...s, items: coerceStringArray(s.items) }));
  out.key_numbers = (Array.isArray(out.key_numbers) ? out.key_numbers : [])
    .filter((n) => n && typeof n === 'object' && (n.label || n.value));
  return out;
}

// Finds an earlier period to compare this one against, preferring the one that
// needs no matching at all.
//
// A prior-year column printed beside the current one came out of the same
// document, so it is definitionally the same building and it works on a
// customer's first purchase. An earlier submission is the one that makes coming
// back next year worth something, and it has to clear an address check first —
// a landlord with three properties will have three histories under one email,
// and comparing the wrong two would report every difference between two
// buildings as a year-over-year change.
async function resolvePriorPeriod(admin, submission, extraction) {
  const inDocuments = extraction.prior_period;
  if (inDocuments && Array.isArray(inDocuments.expenses) && inDocuments.expenses.length) {
    return {
      source: 'prior_period_in_documents',
      address: (extraction.property || {}).address || null,
      income: {
        period_start: inDocuments.period_start,
        period_end: inDocuments.period_end,
        gross_scheduled_rent: inDocuments.gross_scheduled_rent,
        total_collected: inDocuments.total_collected,
        net_operating_income: inDocuments.net_operating_income,
      },
      expenses: inDocuments.expenses,
      expense_total_stated: inDocuments.expense_total_stated,
    };
  }

  if (!submission.email) return null;

  // Scoped to this customer's own email, so a history is only ever compared
  // against itself.
  const { data: earlier, error } = await admin
    .from('navigator_submissions')
    .select('id, form_data, created_at')
    .eq('product', 'rental')
    .eq('email', submission.email)
    .eq('status', 'complete')
    .neq('id', submission.id)
    .order('created_at', { ascending: false })
    .limit(8);
  if (error) return null;

  const candidates = (earlier || [])
    .map((row) => {
      // Not named `stored`: tests/wiring.test.js reads `stored.<key>` in this
      // file as a closing form_data key, and these are fields of a rental
      // extraction rather than storage keys of any kind.
      const priorExtraction = (row.form_data || {}).rental_extraction;
      if (!priorExtraction
        || !priorExtraction.income
        || !Array.isArray(priorExtraction.expenses)
        || !priorExtraction.expenses.length) return null;
      return {
        source: 'earlier_submission',
        address: (priorExtraction.property || {}).address || null,
        income: priorExtraction.income,
        expenses: priorExtraction.expenses,
        expense_total_stated: priorExtraction.expense_total_stated,
        submissionId: row.id,
        // Carried for api/_lib/rental-outcomes.js, which closes out last year's
        // findings against this year's documents. Only an earlier SUBMISSION
        // has these — a prior-year column inside one statement was never
        // audited, so there is nothing of ours to confirm against it.
        priorFindings: Array.isArray((row.form_data || {}).rental_findings)
          ? (row.form_data || {}).rental_findings
          : [],
        priorExtraction,
      };
    })
    .filter(Boolean);

  if (!candidates.length) return null;

  const currentAddress = (extraction.property || {}).address;
  const matched = candidates.find((c) => sameProperty(currentAddress, c.address));
  // No match still returns the most recent, so runRentalTrend can report that a
  // history exists and could not be tied to this property — a customer whose
  // address is printed differently on two statements deserves to know why the
  // comparison they were expecting is missing.
  return matched || candidates[0];
}

// The customer's own previous landlord review, if they have one.
//
// Scoped to their email and to completed landlord submissions, so a history is
// only ever compared against itself. Unlike Rental — which has to match an
// address because one customer can have three buildings under one email — a
// landlord submission already carries the whole portfolio, so the most recent
// completed one IS the right comparison and the per-property matching happens
// inside api/_lib/landlord-outcomes.js.
async function resolvePriorLandlord(admin, submission) {
  if (!submission.email) return null;

  const { data: earlier, error } = await admin
    .from('navigator_submissions')
    .select('id, form_data, created_at')
    .eq('product', 'landlord')
    .eq('email', submission.email)
    .eq('status', 'complete')
    .neq('id', submission.id)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error || !earlier || !earlier.length) return null;
  const row = earlier[0];
  const findings = Array.isArray((row.form_data || {}).landlord_findings)
    ? row.form_data.landlord_findings : [];
  if (!findings.length) return null;

  return { findings, when: String(row.created_at).slice(0, 10), submissionId: row.id };
}

// The customer's own previous Government Money shortlist, if they have one.
//
// This is what makes the "not this year" verb worth anything. A line that was
// ruled out last year and is open now — they bought the house, the work got
// finished, the household changed — is the only honest basis for telling
// somebody to look at something again, and it is the one thing a cold report
// can never say. Scoped to their email and to completed submissions of this
// product, so a history is only ever compared against itself.
//
// Only the verdicts are stored and compared, never an amount: there are no
// amounts anywhere in this product, and a comparison is about what OPENED and
// what CLOSED.
async function resolvePriorGovernmentMoney(admin, submission) {
  if (!submission.email) return null;

  const { data: earlier, error } = await admin
    .from('navigator_submissions')
    .select('id, form_data, created_at')
    .eq('product', 'government-money')
    .eq('email', submission.email)
    .eq('status', 'complete')
    .neq('id', submission.id)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error || !earlier || !earlier.length) return null;
  const row = earlier[0];
  const verdicts = Array.isArray((row.form_data || {}).government_money_verdicts)
    ? row.form_data.government_money_verdicts : [];
  if (!verdicts.length) return null;

  return { verdicts, when: String(row.created_at).slice(0, 10), submissionId: row.id };
}

function guessMediaType(filename) {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/jpeg';
}

// Renders the drafted letters as the plain text navigator-status.html shows
// in its closing block, so the page and the PDF carry the same words.
function renderLettersAsText(emails) {
  const blocks = [];
  for (const [key, label] of [['lender', 'LENDER'], ['settlement', 'SETTLEMENT AGENT']]) {
    const email = emails && emails[key];
    if (!email || !email.body) continue;
    const heading = `EMAIL TO ${label}${email.to ? ` (${email.to})` : ''}`;
    blocks.push(`${heading}\n\nSubject: ${email.subject}\n\n${email.body}`.trim());
  }
  return blocks.join('\n\n---\n\n');
}

async function generateNavigatorReport(submissionId) {
  const admin = getSupabaseAdmin();

  const { data: submission, error: fetchError } = await admin
    .from('navigator_submissions')
    .select('*')
    .eq('id', submissionId)
    .single();

  if (fetchError || !submission) throw new Error('Submission not found');

  const config = PRODUCT_CONFIGS[submission.product];
  if (!config) throw new Error(`No report engine configured for product "${submission.product}"`);

  await admin
    .from('navigator_submissions')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', submissionId);

  try {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY env var');

    const filePaths = submission.file_paths || [];
    if (config.requiresFiles && !filePaths.length) {
      throw new Error(`${config.label} requires at least one uploaded document, but none were found on this submission.`);
    }

    const contentBlocks = [];
    // Files we accepted, stored, and then could not actually read. Told to the
    // customer rather than silently dropped: a rent roll that did not arrive is
    // the difference between four checks running and thirteen, and they are the
    // only person who can send a better copy.
    const unreadableUploads = [];

    for (const path of filePaths) {
      const { data: fileBlob, error: downloadError } = await admin.storage
        .from('navigator-uploads')
        .download(path);
      if (downloadError || !fileBlob) continue;
      const arrayBuffer = await fileBlob.arrayBuffer();

      // A spreadsheet export goes in as text. The document API takes PDFs and
      // images; handing it a CSV under a guessed image type is how .heic used
      // to fail, and the whole point of accepting these is that a rent roll
      // lives in one.
      if (isTabularUpload(path)) {
        // Stored as "<product>/<id>/<timestamp>-<original name>"; the customer
        // only ever knew the last part.
        const name = path.split('/').pop().replace(/^\d+-/, '');
        // Strip the byte-order mark Excel writes, which otherwise becomes a
        // stray character on the first column header.
        const text = Buffer.from(arrayBuffer).toString('utf8').replace(/^\uFEFF/, '');

        // A renamed .xlsx is a binary file wearing a .csv extension, and it is
        // a thing customers genuinely do. Nothing at upload time can catch it —
        // that endpoint sees a filename and a size, never the bytes — so it is
        // caught here and reported, rather than fed to the model as mojibake.
        if (text.indexOf('\u0000') !== -1) {
          unreadableUploads.push(`${name} is not a text CSV — it looks like a binary spreadsheet `
            + '(an .xlsx or .xls renamed). Re-export it with File, then Save As or Download, and pick CSV.');
          continue;
        }

        const clipped = text.length > MAX_TABULAR_CHARS;
        contentBlocks.push({
          type: 'text',
          text: `FILE: ${name}\n\n${clipped ? text.slice(0, MAX_TABULAR_CHARS) : text}`
            + (clipped ? `\n\n[This file was longer than ${MAX_TABULAR_CHARS} characters and was cut off here. Say so in your output — figures past this point were not read.]` : ''),
        });
        continue;
      }

      const base64 = Buffer.from(arrayBuffer).toString('base64');
      const mediaType = guessMediaType(path);
      if (mediaType === 'application/pdf') {
        contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } });
      } else {
        contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
      }
    }
    if (config.requiresFiles && !contentBlocks.length) {
      throw new Error('Could not read any of the attached documents for this submission.');
    }

    const formData = submission.form_data || {};
    const contextLines = [
      formData.category ? `Customer-selected category: ${formData.category}` : null,
      formData.description ? `Customer's description: ${formData.description}` : null,
      `Number of documents attached: ${contentBlocks.length}`,
      // A file the customer sent and we could not open is not a gap in their
      // property, it is a gap in what we read, and only they can close it.
      unreadableUploads.length
        ? `FILES THAT COULD NOT BE READ — say this plainly in missing_or_uncertain, `
          + `in these words, because the customer is the only person who can fix it: `
          + unreadableUploads.join(' ')
        : null,
    ].filter(Boolean).join('\n');

    contentBlocks.push({ type: 'text', text: contextLines || 'No additional context or documents were provided — work from the product task alone and flag the lack of input in missing_or_uncertain.' });

    // Closing Disclosure Audit is the one product where the model is not the
    // analyst. The findings were computed deterministically by closing-audit.js
    // from the extraction captured at the free-scorecard stage; the model's job
    // is to write them up. Handing it the findings as data — rather than the
    // documents plus an instruction to judge — is what stops it inventing a
    // benchmark when the corpus has no entry for a county.
    let auditBlock = '';
    // The lender / settlement-agent letters. Built here on the paid path and
    // attached to the stored report below, so the PDF has something to print.
    // Null for every other product, and null for a clean Closing Disclosure —
    // nothing routed to a party means no letter, and inventing one would spend
    // the customer's credibility with someone they still have to close with.
    let draftedEmails = null;
    // Hoisted so the consistency check below can see what the audit actually
    // computed. The write-up is told "never state a dollar figure that is not
    // present in the findings you were given" — an instruction, which until now
    // nothing verified. api/_lib/report-consistency.js verifies it.
    let closingFindings = null;
    let closingExtraction = null;
    if (submission.product === 'closing') {
      const stored = submission.form_data || {};
      if (!stored.extraction) {
        throw new Error('This closing submission has no stored extraction — the free scorecard step did not complete.');
      }
      // Extract the Loan Estimates now, at report time, from the files already
      // downloaded above. This is the analysis the $59 tier is sold on; before
      // this ran, loanEstimates was always null and the tolerance engine — built
      // and tested — never executed on a paying customer's documents.
      // Reuse what the free scorecard already extracted. Re-reading the same
      // PDFs would be a second model call for an identical result.
      let loanEstimates = Array.isArray(stored.loan_estimates) && stored.loan_estimates.length
        ? stored.loan_estimates
        : null;
      const leIndexes = loanEstimates ? [] : (stored.documents || [])
        .filter((d) => d.document_type === 'loan_estimate')
        .map((d) => d.index)
        .filter((i) => typeof i === 'number' && contentBlocks[i]);

      if (leIndexes.length) {
        const records = [];
        for (const i of leIndexes) {
          try {
            const raw = await extractLoanEstimate(ANTHROPIC_API_KEY, contentBlocks[i]);
            if (raw && raw.is_loan_estimate !== false && (raw.charges || []).length) {
              records.push(toLoanEstimateRecord(raw, `LE${records.length + 1}`));
            }
          } catch (err) {
            // One unreadable Loan Estimate must not take down the whole report.
            console.error('[closing] loan estimate extraction failed:', err.message);
          }
        }
        // selectBaseline needs an issue date to order revisions. Without one we
        // cannot establish which LE governs, and guessing the baseline is worse
        // than declining to test tolerances.
        const dated = records.filter((r) => r.dateIssued);
        if (dated.length) loanEstimates = dated;
      }

      // The initial escrow account statement, if the customer sent one.
      //
      // Check 15 — the RESPA cushion cap — almost never ran, because a Closing
      // Disclosure does not state a cushion. Section G is the whole opening
      // deposit, and applying a two-month cap to it would flag a correctly
      // funded account, so the engine declined and said so. This is the
      // document that does state it, and asking for it is what turns the check
      // from an apology into a result. Read at report time from the file the
      // classifier already identified, exactly as the Loan Estimates are.
      const escrowIndexes = (stored.documents || [])
        .filter((d) => d.document_type === 'initial_escrow_account_statement')
        .map((d) => d.index)
        .filter((i) => typeof i === 'number' && contentBlocks[i]);

      for (const i of escrowIndexes) {
        try {
          const statement = await extractEscrowStatement(ANTHROPIC_API_KEY, contentBlocks[i]);
          if (mergeEscrowStatement(stored.extraction, statement)) break;
        } catch (err) {
          // An unreadable escrow statement costs one optional check, not the
          // report. The cushion check reports honestly that it could not run.
          console.error('[closing] escrow statement extraction failed:', err.message);
        }
      }

      // runDocumentAudit, NOT runClosingAudit — the same entry point the free
      // scorecard uses. This was the single most damaging defect in the product.
      //
      // runClosingAudit is the raw engine. runDocumentAudit is the engine PLUS
      // the document-intrinsic loan maths — APR against the amount financed,
      // finance charge against the payment stream, total of payments, amount
      // financed, TIP, monthly principal and interest, monthly escrow, discount
      // points — and MINUS the retired cannot-benchmark findings.
      //
      // Calling the raw engine here meant the paid report was built from a
      // SMALLER audit than the free scorecard. Not merely fewer reassurances:
      // fewer errors. An APR disclosed below the note rate — a confirmed
      // mathematical error and a potential TRID violation, checks 03 and 04 of
      // the twenty-seven the page enumerates — was caught by the free scorecard
      // and did not appear anywhere in the report the customer paid $59 for.
      // Verified by planting exactly that error and running both paths.
      //
      // It also explains two things that looked like the model ignoring its
      // instructions. Told to name every passed check, it named one, because
      // one was all it was given. Told never to mention benchmarking, it kept
      // producing a section about it, because six cannot-benchmark findings
      // were in the findings it was told to write up and not omit. Both were
      // this call.
      const audited = runDocumentAudit({
        extraction: stored.extraction,
        answers: stored.answers || {},
        loanEstimates,
        // Extracted at the free scorecard stage and reused here, like the Loan
        // Estimates — re-reading the contract would be a second model call for
        // an identical result.
        contractTerms: stored.contract_terms || null,
      });
      const { skipped, cureNote } = audited;
      const findings = audited.findings;

      if (leIndexes.length && !loanEstimates) {
        findings.unshift({
          checkId: 'TRID_NOT_RUN',
          title: 'Tolerance testing could not be run on the Loan Estimates provided',
          severity: 'requires_documentation',
          evidence: 'no_evidence_available',
          actionability: 'requires_additional_documentation',
          basis: 'The Loan Estimates could not be read clearly enough, or carried no issue date, '
            + 'which is needed to establish which one governs the tolerance baseline.',
          recommendedAction: 'Upload a clearer copy of each Loan Estimate, including the date issued.',
          detail: {},
        });
      }
      // Ranked once, then used for both the write-up and the letters. If the
      // model saw one order and the letters used another, a customer reading
      // the PDF top to bottom would meet the same findings twice in two
      // different priorities.
      const ranked = rankFindings(findings);
      closingFindings = ranked;
      closingExtraction = stored.extraction;

      draftedEmails = buildEmails(ranked, {
        propertyAddress: stored.extraction.property_address,
        closingDate: stored.extraction.closing_date,
        borrowerName: Array.isArray(stored.extraction.borrower_names)
          ? stored.extraction.borrower_names.filter(Boolean).join(' and ')
          : null,
        lenderName: stored.extraction.lender_name,
        // Without this the settlement agent's letter was addressed to nobody —
        // `to: null` — even though the agent is named on the first page of every
        // Closing Disclosure. The model's own draft named them correctly because
        // it reads the document; the structured letter could not, because the
        // name was never extracted.
        settlementName: stored.extraction.settlement_agent_name,
      });

      // Flagged and passed are handed over SEPARATELY, and that is deliberate.
      //
      // They used to go as one ranked array. Severity order puts within-norms
      // last, so ten passed checks sat at the bottom of a long JSON blob behind
      // the four that needed action — and the report named exactly one of them,
      // even after the instruction to name them all was added. The writer was
      // not disobeying so much as summarising the tail of a list.
      //
      // Those ten are not filler. Each is a figure the lender printed and we
      // reproduced independently: the APR against the amount financed, the
      // finance charge against the payment stream, the escrow against the
      // disclosed annual costs. On a document with nothing wrong they are the
      // entire product, and a customer who paid $59 to be told "your lender's
      // arithmetic is correct" deserves to see which arithmetic was checked.
      const passed = ranked.filter((f) => f.severity === Severity.WITHIN_NORMS);
      const flagged = ranked.filter((f) => f.severity !== Severity.WITHIN_NORMS);

      auditBlock = [
        '',
        'AUDIT FINDINGS — these are the report. Write these up. Do not add to them, do not',
        'recompute them, and do not soften or escalate any severity.',
        JSON.stringify(flagged, null, 1),
        '',
        passed.length
          ? [
            `CHECKS THAT RAN AND PASSED — ${passed.length} of them, listed below.`,
            'These belong in the "what was independently verified" section. Name EVERY ONE,',
            'each with the figure behind it, in the engine\'s own words. Do not compress them',
            'into "other checks passed", do not pick a representative few, and do not drop any',
            'for length — this list is the work the customer paid for.',
            JSON.stringify(
              passed.map((f) => ({ title: f.title, basis: f.basis, charged: f.charged })),
              null, 1
            ),
          ].join('\n')
          : '',
        skipped.length
          ? `Checks that could not be run because the required values were missing or unreadable: ${skipped.join(', ')}. Say so plainly rather than implying they passed.`
          : '',
        cureNote || '',
      ].filter(Boolean).join('\n');
    }

    // Rental Navigator, on the same arrangement as Closing: read the documents
    // into numbers, judge the numbers deterministically, and hand the model the
    // findings rather than the documents plus an instruction to look for
    // problems. See api/_lib/rental-audit.js for what that fixed.
    //
    // The one branch back to the old behaviour is at the bottom: if extraction
    // produces nothing a single check can run on — a photograph too dark to
    // read, a document that turns out not to be a rent roll — the customer has
    // still paid, and a thinner analysis they are told is thinner beats an empty
    // report. That fallback is the exception and it announces itself.
    // Assembled in the landlord branch below, attached after generation.
    let landlordPack = null;
    let usedFallbackAnalysis = false;
    // Hoisted: the entitlement is granted after the report is stored, well below
    // this block, and it records the property address the extraction found.
    let rentalExtraction = null;
    if (submission.product === 'rental') {
      let extraction = null;
      try {
        extraction = await extractRentalDocuments(ANTHROPIC_API_KEY, contentBlocks);
        rentalExtraction = extraction;
      } catch (err) {
        console.error('[rental] extraction failed:', err.message);
      }

      const audited = extraction ? runRentalAudit(extraction) : { findings: [], skipped: [], checksRun: 0 };

      // Year over year, when there is a year to compare against. Merged into the
      // same ranked list rather than bolted on at the end: a cost that rose 40%
      // against the same building last year outranks one that merely sits above
      // a typical range, and the ordering has to say so.
      let trend = { findings: [], skipped: [], comparedTo: null };
      let outcomes = null;
      if (extraction) {
        try {
          const prior = await resolvePriorPeriod(admin, submission, extraction);
          if (prior) {
            trend = runRentalTrend(extraction, prior);
            // Closing out last year's findings needs a last year's AUDIT, not
            // merely an earlier column of figures, so this only runs on the
            // returning-customer path.
            if (prior.source === 'earlier_submission' && (prior.priorFindings || []).length) {
              const closed = runRentalOutcomes(prior.priorFindings, extraction, prior.priorExtraction);
              if (closed.outcomes.length) outcomes = closed;
            }
          }
        } catch (err) {
          // A comparison that cannot be built is a missing section, not a
          // missing report. The deterministic checks stand on their own.
          console.error('[rental] year-over-year comparison failed:', err.message);
        }
      }

      const allFindings = rankRentalFindings(audited.findings.concat(trend.findings));
      const allSkipped = audited.skipped.concat(trend.skipped);

      if (allFindings.length) {
        const flagged = allFindings.filter((f) => f.severity !== RentalSeverity.WITHIN_NORMS);
        const passed = allFindings.filter((f) => f.severity === RentalSeverity.WITHIN_NORMS);

        draftedEmails = buildRentalEmails(allFindings, {
          propertyAddress: (extraction.property || {}).address || null,
          managerName: (extraction.management || {}).company_name || null,
        });

        // Flagged and passed go over separately for the reason the Closing
        // branch above documents: severity order puts within-norms last, and a
        // writer told to name every passed check will summarise the tail of one
        // long list no matter how firmly it is instructed not to.
        auditBlock = [
          '',
          'AUDIT FINDINGS — these are the report. Write these up. Do not add to them, do not',
          'recompute them, and do not soften or escalate any severity.',
          JSON.stringify(flagged, null, 1),
          '',
          passed.length
            ? [
              `CHECKS THAT RAN AND PASSED — ${passed.length} of them, listed below.`,
              'These belong in the "what was independently verified" section. Name EVERY ONE,',
              'each with the figure behind it, in the engine\'s own words. Do not compress them',
              'into "other checks passed", do not pick a representative few, and do not drop any',
              'for length — this list is the work the customer paid for.',
              JSON.stringify(passed.map((f) => ({ title: f.title, basis: f.basis })), null, 1),
            ].join('\n')
            : '',
          `COVERAGE — ${audited.checksRun} of ${audited.checksTotal} checks ran on these documents.`,
          'This figure goes in key_numbers, labelled "checks run", on every report. It is the number',
          'that separates two results a customer will otherwise confuse: a property that was examined',
          'and is fine, and a property we could barely examine. Where coverage is high and nothing was',
          'flagged, say so with the number — that is a clean bill of health on work actually done, and',
          'it is what the customer paid for. Where coverage is LOW, the headline must say that the',
          'documents, not the property, are the limit, and the report must name the specific documents',
          'that would raise it — a mortgage statement, a declarations page, a statement showing the',
          'monthly utility figures. Never let a low-coverage report read as a clean bill of health.',
          trend.comparedTo
            ? [
              '',
              `YEAR OVER YEAR — this property was compared against its own ${trend.comparedTo.label} period, `
                + `taken from ${trend.comparedTo.source === 'earlier_submission'
                  ? 'the audit this customer bought previously'
                  : 'the earlier column printed in the documents they uploaded'}.`,
              'Give this its own section and say which period it is against. These findings are the one',
              'place the audit can call a cost high without appealing to what is typical anywhere else —',
              'the comparison is the same building twelve months earlier, which is a fact about their',
              'property. Say that, because it is what makes the number worth acting on.',
              'Never compare figures the engine did not compare, and never extend the comparison to a',
              'line that is not in a finding.',
            ].join('\n')
            : '',
          outcomes
            ? [
              '',
              'WHAT LAST YEAR\'S FINDINGS DID — the outcome of the audit this customer already paid for,',
              'read out of the documents they have just sent rather than asked of them. Give it its own',
              'section, near the top, before this year\'s findings.',
              `${outcomes.resolved} resolved, ${outcomes.improved} improved, ${outcomes.stillOpen} still open, `
                + `${outcomes.notTestable} not testable from what was sent this time.`,
              outcomes.confirmedRecovered > 0
                ? `CONFIRMED RECOVERED: $${outcomes.confirmedRecovered.toLocaleString('en-US')} a year. This figure `
                  + 'is money a document proves stopped leaving the account or started arriving. Use it, and use '
                  + 'it exactly — do not round it up, do not add anything to it, and do not describe any other '
                  + 'number in this report as recovered. Several outcomes below are resolved with no figure '
                  + 'attached, deliberately: a statement that now adds up does not mean the earlier difference '
                  + 'was refunded, and sub-metering shifts a cost without proving how much of it reached the '
                  + 'tenants. Report those as resolved, without money.'
                : 'Nothing is confirmed recovered yet. Say that plainly rather than implying progress.',
              'A "not testable" outcome means this year\'s upload does not contain the document that would',
              'answer it. It is NOT a pass, it is NOT progress, and it must never be written as either —',
              'name the document that would close it.',
              JSON.stringify(outcomes.outcomes, null, 1),
            ].join('\n')
            : '',
          allSkipped.length
            ? `Checks that could not be run because the required figures were missing or unreadable: `
              + `${allSkipped.join('; ')}. Say so plainly rather than implying they passed.`
            : '',
          (extraction.unreadable || []).length
            ? `The extraction could not read these parts of the documents: ${(extraction.unreadable || []).join('; ')}.`
            : '',
        ].filter(Boolean).join('\n');

        // Kept on the submission so a future re-run can compare this period
        // against the next one without asking for these documents again.
        await admin
          .from('navigator_submissions')
          .update({
            form_data: {
              ...formData,
              rental_extraction: extraction,
              rental_checks_run: audited.checksRun,
              // The findings themselves, as data rather than as the prose the
              // model wrote about them. Next year's audit reads these to work
              // out which of them the landlord actually acted on — see
              // api/_lib/rental-outcomes.js. Projected down to the fields the
              // resolvers use, because storing the write-up would be storing
              // the same thing twice and the basis strings are long.
              rental_findings: allFindings
                .filter((f) => f.severity !== RentalSeverity.WITHIN_NORMS)
                .map((f) => ({
                  checkId: f.checkId,
                  title: f.title,
                  severity: f.severity,
                  dollarImpact: f.dollarImpact === undefined ? null : f.dollarImpact,
                  impactKind: f.impactKind || null,
                  charged: f.charged === undefined ? null : f.charged,
                  expected: f.expected === undefined ? null : f.expected,
                  detail: f.detail || {},
                })),
            },
            updated_at: new Date().toISOString(),
          })
          .eq('id', submissionId);
      } else {
        usedFallbackAnalysis = true;
        console.error('[rental] no deterministic findings — falling back to document analysis');
      }
    }

    // Landlord Navigator, on the same arrangement as Closing and Rental: decide
    // the findings here, hand them to the model as data, and let it write.
    //
    // The input is different in kind — structured answers from the intake form
    // rather than figures extracted from an uploaded statement — but the reason
    // is identical. Told to produce a compliance checklist from a paragraph of
    // prose, a model produces whatever the paragraph brought to mind; told to
    // write up "Seattle runs RRIO and you said this property is not enrolled",
    // it writes that. See api/_lib/landlord-audit.js for what this replaced.
    if (submission.product === 'landlord') {
      let properties = Array.isArray(formData.properties) ? formData.properties : [];

      // A registration expiry the landlord left blank is usually printed on the
      // licence they uploaded, and that one date drives both the renewal check
      // and the reminder that fires before it. Only ever fills a blank — a date
      // they typed is the one they will recognise, and the document may be an
      // old copy. See api/_lib/landlord-extract.js.
      let licencesFilled = [];
      if (contentBlocks.length > 1) {
        try {
          const read = await extractLandlordLicences(ANTHROPIC_API_KEY, contentBlocks);
          const applied = applyLicences(properties, read.licences);
          properties = applied.properties;
          licencesFilled = applied.filled;
        } catch (err) {
          // An unreadable licence costs the extra date, never the report.
          console.error('[landlord] licence extraction failed:', err.message);
        }
      }

      const audited = runLandlordAudit({ properties });

      // What last year's findings did, read out of this year's answers rather
      // than asked of the customer. Only runs for somebody who has been here
      // before — see api/_lib/landlord-outcomes.js for why asking would have
      // been easier and worth nothing.
      let outcomes = null;
      try {
        const prior = await resolvePriorLandlord(admin, submission);
        if (prior && prior.findings.length) {
          const closed = runLandlordOutcomes(prior.findings, properties);
          if (closed.outcomes.length) outcomes = Object.assign({ when: prior.when }, closed);
        }
      } catch (err) {
        // A comparison that cannot be built is a missing section, not a missing
        // report. This year's checks stand on their own.
        console.error('[landlord] outcome comparison failed:', err.message);
      }

      if (audited.findings.length) {
        const flagged = audited.findings.filter((f) => f.severity !== LandlordSeverity.WITHIN_NORMS);
        const passed = audited.findings.filter((f) => f.severity === LandlordSeverity.WITHIN_NORMS);

        // Flagged and passed go over separately for the reason the two branches
        // above document: severity order puts within-norms last, and a writer
        // told to name every passed check will summarise the tail of one long
        // list however firmly it is instructed not to.
        auditBlock = [
          '',
          'AUDIT FINDINGS — these are the report. Write these up. Do not add to them, do not',
          'recompute them, and do not soften or escalate any severity. Each carries its own',
          'confidence: write "high" as a statement and "check" as likely-and-worth-confirming.',
          JSON.stringify(flagged, null, 1),
          '',
          passed.length
            ? [
              `CHECKS THAT RAN AND PASSED — ${passed.length} of them, listed below.`,
              'These belong in a "what was checked and is fine" section. Name EVERY ONE, against the',
              'property it belongs to. Do not compress them into "other checks passed" and do not drop',
              'any for length — on a portfolio with little wrong, this list is the product.',
              JSON.stringify(
                passed.map((f) => ({ property: f.property, title: f.title, basis: f.basis })),
                null, 1
              ),
            ].join('\n')
            : '',
          `COVERAGE — ${audited.checksRun} of ${audited.checksTotal} checks ran across `
            + `${audited.propertyCount} propert${audited.propertyCount === 1 ? 'y' : 'ies'}.`,
          'This figure goes in key_numbers, labelled "checks run", on every report. It separates two',
          'results a customer will otherwise confuse: a portfolio that was examined and is fine, and one',
          'we could barely examine because fields were left blank. Where coverage is low, the headline',
          'must say that the answers, not the properties, are the limit, and the report must name the',
          'specific questions that would raise it.',
          audited.coverage.uncovered.length
            ? 'JURISDICTIONS WE HOLD NO REFERENCE ENTRY FOR: '
              + `${audited.coverage.uncovered.join('; ')}. Say this plainly and early, in missing_or_uncertain `
              + 'and in the body. A landlord in one of these places must not read a short report as a clean one.'
            : '',
          audited.skipped.length
            ? `Checks that could not run because a field was left blank: ${audited.skipped.join('; ')}. `
              + 'Name them rather than implying they passed, and say which answer would turn each one on.'
            : '',
          licencesFilled.length
            ? 'DATES READ OFF AN UPLOADED LICENCE, not entered by the customer: '
              + licencesFilled.map((f) => f.property + ' expires ' + f.expires).join('; ')
              + '. Say so wherever one of these dates appears — the customer did not give it to us, and a date we read off a document they may have replaced has to be presented as something to confirm.'
            : '',
          outcomes
            ? [
              '',
              'WHAT LAST YEAR\'S FINDINGS DID — the outcome of the review this customer already paid',
              `for, read out of the answers they have just given rather than asked of them. It was run`,
              `on ${outcomes.when}. Give this its own section, near the top, before this year's findings.`,
              `${outcomes.resolved} resolved, ${outcomes.improved} improved, ${outcomes.stillOpen} still open, `
                + `${outcomes.notTestable} not testable from what was entered this time.`,
              'A "not testable" outcome means a question was left blank this time. It is NOT a pass, it is',
              'NOT progress, and it must never be written as either — name the answer that would close it.',
              'An "improved" outcome is not a "resolved" one: say what changed and what still stands.',
              'Resolutions here rest on the landlord\'s own answers, not on anything we checked with a',
              'city. Write them as "you told us" rather than as verified fact.',
              JSON.stringify(outcomes.outcomes, null, 1),
            ].join('\n')
            : '',
        ].filter(Boolean).join('\n');

        // Kept on the submission so next year's review can close these out
        // without asking the customer what they did. The per-finding `answers`
        // snapshot is what lets a date comparison work — a renewal is only
        // proved by the expiry moving, which needs the old one.
        landlordPack = buildLandlordPack(audited.findings, { coverage: audited.coverage });

        const byName = new Map();
        properties.forEach((p, i) => byName.set(landlordLabel(p, i), p));
        await admin
          .from('navigator_submissions')
          .update({
            form_data: {
              ...formData,
              landlord_checks_run: audited.checksRun,
              landlord_findings: audited.findings
                .filter((f) => f.severity !== LandlordSeverity.WITHIN_NORMS && f.property)
                .map((f) => ({
                  checkId: f.checkId,
                  property: f.property,
                  title: f.title,
                  severity: f.severity,
                  answers: byName.get(f.property) || {},
                })),
            },
            updated_at: new Date().toISOString(),
          })
          .eq('id', submissionId);
      } else {
        // No properties entered at all. The intake blocks this client- and
        // server-side, so reaching here means something upstream let a blank
        // submission through, and the report has to say so rather than
        // inventing a portfolio to talk about.
        auditBlock = [
          '',
          'NO PROPERTY DETAILS WERE RECORDED for this submission, so not one check could run.',
          'Say that first, plainly, in the summary and again in missing_or_uncertain. Do not produce a',
          'general landlord compliance article in its place — that is not what was paid for. Tell them to',
          'reply to their receipt with the address, build year and city of each property so the review',
          'can be run.',
        ].join('\n');
      }
    }

    // Subscription Navigator. The recommendations are computed here, not by
    // the model — see navigator-subscription-engine.js and the task prompt
    // above. Handing the writer the decisions as data, rather than the
    // customer's list plus an instruction to judge it, is what stops it
    // telling somebody to cancel a prepaid annual plan because they only used
    // it twice.
    let subscriptionAnalysis = null;
    if (submission.product === 'subscriptions') {
      const lines = Array.isArray(formData.lines) ? formData.lines : [];
      if (lines.length) {
        subscriptionAnalysis = subscriptionEngine.analyze({ lines });
        const a = subscriptionAnalysis;

        // Blocked lines go over separately from the decided ones for the same
        // reason landlord's passed checks do: they sort last, and a writer
        // told to cover every one of a long list will summarise its tail
        // however firmly it is instructed not to. These are the lines where
        // the product refused to give an answer, which is the part a customer
        // is most likely to think was an omission, so it gets its own heading
        // and its own instruction.
        const blocked = a.decisions.filter((d) => d.action === subscriptionEngine.Action.REVIEW);
        const decided = a.decisions.filter((d) => d.action !== subscriptionEngine.Action.REVIEW);

        auditBlock = [
          '',
          'DECISIONS — these are the report. Write these up. Do not add to them, do not',
          'recompute one, and do not change an action. Every figure you may state is here.',
          JSON.stringify(decided, null, 1),
          '',
          blocked.length
            ? [
              `LINES THE ENGINE REFUSED TO DECIDE — ${blocked.length} of them, below.`,
              'These need their own section. Every one is a line where telling the customer to',
              'cancel would have cost them money, deleted something of theirs, or made a decision',
              'that was not theirs alone to make. Write each one as the product working: name what',
              'is at stake and what the customer should check. Never convert one into a cancel',
              'recommendation, however clearly the usage answers point that way.',
              JSON.stringify(blocked, null, 1),
            ].join('\n')
            : '',
          '',
          a.overlaps.length
            ? 'DUPLICATE COVERAGE — name this in a short section, without choosing for them:\n'
              + JSON.stringify(a.overlaps, null, 1)
            : '',
          '',
          'TOTALS — the headline savings figure is confirmedAnnual and nothing else. Never add',
          'these together. conditionalAnnual is cycles skipped, not a year. atRiskAnnual is shown',
          'and never counted. unpricedLines have no figure at all and must not be given one.',
          JSON.stringify({
            lineCount: a.lineCount,
            monthlySpend: a.monthlySpend,
            annualSpend: a.annualSpend,
            confirmedAnnual: a.totals.confirmedAnnual,
            conditionalAnnual: a.totals.conditionalAnnual,
            atRiskAnnual: a.totals.atRiskAnnual,
            unpricedLines: a.totals.unpricedLines,
            reviewLines: a.totals.reviewLines,
          }, null, 1),
        ].filter(Boolean).join('\n');
      } else {
        // The intake gate blocks this client- and server-side, so reaching
        // here means something upstream let a blank submission through. Say
        // so rather than writing a general article about subscriptions, which
        // is not what was paid for.
        auditBlock = [
          '',
          'NO SUBSCRIPTION LINES WERE RECORDED for this submission, so not one decision could be',
          'made. Say that first, plainly, in the summary and again in missing_or_uncertain. Do not',
          'produce general advice about managing subscriptions in its place. Tell them to reply to',
          'their receipt with what they pay for and what each one costs, and the review will be run.',
        ].join('\n');
      }
    }

    // Home Savings Navigator. Same shape and same reason as Subscriptions
    // above: the findings are computed by navigator-home-savings-engine.js
    // from the structured answers the customer gave alongside their bills, and
    // the model presents them. The uploaded documents are still attached — the
    // writer quotes them — but nothing it reads in them may become a finding.
    let homeSavingsAnalysis = null;
    if (submission.product === 'home-savings') {
      let bills = Array.isArray(formData.bills) ? formData.bills : [];

      // Read the statements before running the checks.
      //
      // This is the difference between the free scorecard and the report the
      // customer paid for. The scorecard runs the same seven checks against
      // what they typed; this runs them against what is printed. A modem
      // rental the customer guessed at $12 and the bill prints at $15, an
      // add-on they never mentioned, a promotional end date nobody remembers,
      // an instalment agreement the bill itself says is complete — none of
      // those are available to a form.
      //
      // The model transcribes and a pattern table classifies; see
      // home-savings-extract.js. It is allowed to be wrong about what a line
      // SAYS, which the confidence gate catches, and it is not allowed to
      // decide what a line IS.
      let extractionQuestions = [];
      let extractionDisagreements = [];
      let extractionFailure = null;
      let billsRead = 0;
      if (bills.length && contentBlocks.length) {
        try {
          const read = await extractHouseholdBills(ANTHROPIC_API_KEY, contentBlocks);
          const merged = mergeHouseholdBills(bills, read);
          bills = merged.bills;
          extractionQuestions = merged.newQuestions;
          extractionDisagreements = merged.disagreements;
          billsRead = (read.bills || []).length;
        } catch (err) {
          // The answers the customer typed are a complete input on their own —
          // that is what the free scorecard runs on. A failed read costs the
          // report its document-grounded half, and the customer is told which
          // half they got rather than being handed a thinner report that looks
          // identical to a full one.
          //
          // Reported through the audit block rather than `unreadableUploads`,
          // which is folded into the context text hundreds of lines above this
          // point and is already sealed by the time extraction runs.
          extractionFailure = err.message;
        }
      }

      if (bills.length) {
        homeSavingsAnalysis = homeSavingsEngine.analyze({ bills }, {
          openQuestions: extractionQuestions,
          disagreements: extractionDisagreements,
        });
        const a = homeSavingsAnalysis;
        const block = homeSavingsEngine.toAuditBlock(a);

        const refused = block.findings.filter((f) => f.action === homeSavingsEngine.Action.REVIEW);
        const decided = block.findings.filter((f) => f.action !== homeSavingsEngine.Action.REVIEW);

        auditBlock = [
          '',
          extractionFailure
            ? [
              'THE STATEMENTS COULD NOT BE READ. Every finding below comes from the answers the',
              `customer typed, not from their documents (reason: ${extractionFailure}).`,
              'Say this plainly in missing_or_uncertain and do NOT quote any bill, cite any line',
              'label, or imply a statement was consulted — nothing in this report was read off',
              'one. Tell them to reply to their receipt and we will re-run it against the',
              'documents at no extra charge.',
            ].join('\n')
            : billsRead
              ? `THE STATEMENTS WERE READ — ${billsRead} of them. Findings whose basis begins `
                + `"Read from your statement" are quoting a line printed on their bill; quote it `
                + `back exactly as the basis gives it. Findings without that are from the form, `
                + `and must not be dressed up as document findings.`
              : '',
          '',
          'FINDINGS — these are the report. Write these up. Do not add to them, do not recompute',
          'one, and do not change an action. Every figure you may state is here.',
          JSON.stringify(decided, null, 1),
          '',
          refused.length
            ? [
              `FINDINGS THE ENGINE REFUSED TO DECIDE — ${refused.length} of them, below.`,
              'These need their own section. Every one is a case where telling the customer to',
              'stop paying would have cost them something the arithmetic cannot see — cover they',
              'told us they rely on, or a saving too small to be worth the call. Write each one as',
              'the product working: name what is at stake and what they should check. Never',
              'convert one into a recommendation to stop paying.',
              JSON.stringify(refused, null, 1),
            ].join('\n')
            : '',
          '',
          block.couldNotRun.length
            ? 'CHECKS THAT COULD NOT RUN — give these their own section, in these words. Each is a\n'
              + 'question only the customer can answer, and each is a finding they have not had yet:\n'
              + JSON.stringify(block.couldNotRun, null, 1)
            : '',
          '',
          block.openQuestions.length
            ? [
              'READ OFF THE STATEMENTS, AND NOT YET DECIDED — put these in the same section as the',
              'checks that could not run, or in their own. Each is a line we found on the bill that',
              'the customer never mentioned, or a change we can see but cannot interpret. Ask the',
              'question as it is written. DO NOT turn one into a recommendation and DO NOT put a',
              'figure from one into any total: an add-on on the statement is not an add-on they',
              'want rid of, and only they know which.',
              JSON.stringify(block.openQuestions, null, 1),
            ].join('\n')
            : '',
          '',
          block.disagreements.length
            ? [
              'WHERE THE STATEMENT DISAGREED WITH THE FORM — report these plainly and without',
              'blame. The customer answered from memory and the bill says otherwise; we used the',
              'bill. Saying so is the point, because it is how they know the report read their',
              'documents rather than replaying their own answers back at them.',
              JSON.stringify(block.disagreements, null, 1),
            ].join('\n')
            : '',
          '',
          'TOTALS — the headline savings figure is confirmedAnnual and nothing else. Never add',
          'these together. promoExposureAnnual is a rise that has not happened; increaseAnnual is',
          'one that already has; neither is a saving and neither may be called one. unpricedFindings',
          'have no figure at all and must not be given one.',
          JSON.stringify({
            billCount: block.billCount,
            checkCount: block.checkCount,
            checkRuns: block.checkRuns,
            monthlySpend: block.monthlySpend,
            annualSpend: block.annualSpend,
            confirmedAnnual: block.totals.confirmedAnnual,
            promoExposureAnnual: block.totals.promoExposureAnnual,
            increaseAnnual: block.totals.increaseAnnual,
            unpricedFindings: block.totals.unpricedFindings,
            reviewFindings: block.totals.reviewFindings,
          }, null, 1),
        ].filter(Boolean).join('\n');
      } else {
        // The intake gate blocks this client- and server-side, so reaching
        // here means something upstream let a submission through with no
        // named bills. Say so rather than writing a general article about
        // saving money on household bills, which is not what was paid for.
        auditBlock = [
          '',
          'NO BILLS WERE RECORDED for this submission, so not one check could run. Say that first,',
          'plainly, in the summary and again in missing_or_uncertain. Do not produce general advice',
          'about lowering household bills in its place. Tell them to reply to their receipt naming',
          'each bill, who it is from and what it costs, and the audit will be run.',
        ].join('\n');
      }
    }

    // Government Money Finder. Same shape and same reason as Subscriptions and
    // Home Savings above: the shortlist is decided by
    // navigator-government-money-engine.js against data/government-programs.json,
    // and the model presents it.
    //
    // The difference on this product is what the engine refuses to hand over.
    // There is no amount anywhere in the decisions — the catalogue holds gates
    // and authorities and no figures at all — so the writer physically cannot
    // state one from the data it is given. That is the audit's central finding
    // closed structurally rather than by instruction.
    let governmentMoneyAnalysis = null;
    if (submission.product === 'government-money') {
      governmentMoneyAnalysis = governmentMoneyEngine.analyze(formData);

      if (governmentMoneyAnalysis) {
        const g = governmentMoneyAnalysis;
        const V = governmentMoneyEngine.Verdict;
        const pick = (v) => g.lines.filter((l) => l.verdict === v);

        // The re-check. Only ever a comparison against this customer's own
        // previous shortlist, and only of verdicts.
        let changed = null;
        const prior = await resolvePriorGovernmentMoney(admin, submission);
        if (prior) changed = governmentMoneyEngine.compareWithPrior(g, prior.verdicts);

        auditBlock = [
          '',
          'THE SHORTLIST — these are the report. Write these up. Do not add a program, do not',
          'change a verdict, and do not state a figure. There are no figures here because we hold',
          'none; "amountGovernedBy" is what you say instead, and the authority is the answer.',
          JSON.stringify(pick(V.CLAIM), null, 1),
          '',
          pick(V.CHECK).length
            ? [
              `LINES THE ENGINE WOULD NOT SETTLE — ${pick(V.CHECK).length} of them, below.`,
              'These need their own section. Each is a line where a deciding fact was never',
              'established — usually the tax-liability answer or the income band — or where what we',
              'hold about that kind of program is "commonly true" rather than settled. Write each',
              'one as likely-and-worth-confirming, in those words. Presenting one of these as',
              'settled fact is the single most damaging thing you can do in this report.',
              JSON.stringify(pick(V.CHECK), null, 1),
            ].join('\n')
            : '',
          '',
          pick(V.NOT_NOW).length
            ? [
              'NOT THIS YEAR — each of these carries a revisit date or a named event. Reproduce it',
              'exactly. A line saying "not this year" without saying when is not actionable, and the',
              'date is the product.',
              JSON.stringify(pick(V.NOT_NOW), null, 1),
            ].join('\n')
            : '',
          '',
          `RULED OUT — ${pick(V.RULED_OUT).length} programs, each with the fact that ruled it out.`,
          'These get their own section and must not be dropped for length. A customer who learns',
          'which programs are not for them, and why, has been saved the evenings. Group them so it',
          'reads quickly, but name every one.',
          JSON.stringify(pick(V.RULED_OUT).map((l) => ({
            label: l.label, scope: l.scope, because: l.blockers.map((b) => b.say),
          })), null, 1),
          '',
          g.stacking.length
            ? 'STACKING — a utility rebate and a federal credit touching the same purchase. Both\n'
              + 'lines already carry the order to work them out in. Say it once, clearly, in its own\n'
              + 'short section as well:\n' + JSON.stringify(g.stacking, null, 1)
            : '',
          '',
          g.sharedCaps.length
            ? 'SHARED ANNUAL CEILINGS — these lines do not stack into several ceilings:\n'
              + JSON.stringify(g.sharedCaps, null, 1)
            : '',
          '',
          changed && changed.changes.length
            ? [
              `WHAT CHANGED since this customer's shortlist of ${prior.when}. This is the only`,
              'basis on which you may tell them to look at something again. "opened" means it is',
              'available to them now and was not; "closed" means the reverse. Lead with an opened',
              'line if there is one.',
              JSON.stringify(changed.changes, null, 1),
            ].join('\n')
            : prior
              ? `This customer also bought a shortlist on ${prior.when}, and nothing has moved since.`
                + ' Say so plainly — a customer told their position is unchanged has been told'
                + ' something useful.'
              : '',
          '',
          'OPEN QUESTIONS — reproduce these, in missing_or_uncertain, in these words:',
          JSON.stringify(g.openQuestions, null, 1),
          '',
          'COUNTS — key_numbers takes these and nothing else. Never a program figure.',
          JSON.stringify(g.totals, null, 1),
          '',
          `The catalogue behind this report was last reviewed on ${g.asOf}. Say so.`,
          g.totals.shortlist === 0 && g.totals.toConfirm === 0
            ? [
              '',
              'THIS REPORT IS BEING REFUNDED AUTOMATICALLY. Nothing at all came back for this',
              'household — no shortlist and nothing even worth confirming — so the charge is already',
              'queued to be returned and the customer keeps the report. Say so plainly in the',
              'summary, in these terms: we checked every program we hold, here is the fact that',
              'rules each one out, and you are not paying for this. Do NOT hedge it, do not ask them',
              'to request it, and do not manufacture a lead to soften it — a customer told honestly',
              'that they are not missing anything has been told something useful.',
            ].join('\n')
            : '',
        ].filter(Boolean).join('\n');
      } else {
        // The intake gate blocks this client- and server-side, so reaching
        // here means a submission arrived without the structured answers — in
        // practice, a browser holding a cached copy of the old free-text page.
        // Say what was and was not run rather than passing a prose read off as
        // the shortlist they paid for.
        auditBlock = [
          '',
          'THIS SUBMISSION CARRIES NO STRUCTURED ANSWERS, so the decision engine could not run and',
          'no program was checked against anything. Say that first, plainly, in the summary and',
          'again in missing_or_uncertain. Work only from the free text below, name no program you',
          'are not confident is a long-standing category, state no amount whatsoever, and end every',
          'line at the office that can confirm it. Then tell them to reply to their receipt with',
          'their state, whether they own or rent, household size, income band and whether they',
          'expect to owe federal income tax, and the full shortlist will be run at no extra charge.',
        ].join('\n');
      }
    }

    // Insurance Navigator. Same shape and same reason as Closing, Rental,
    // Landlord, Subscriptions, Home Savings and Government Money above: the
    // findings are computed by api/_lib/insurance-audit.js from a structured
    // read of the renewal notice and, when the customer sent one, their
    // prior policy — see api/_lib/insurance-extract.js — and the model
    // presents them. Nothing the model notices in the documents on its own
    // may become a finding, which is what closes the gap
    // docs/INSURANCE-AUDIT.md found: a single-pass read asked to render a
    // verdict on whether a renewal "looks typical," backed by nothing this
    // codebase holds.
    let insuranceAnalysis = null;
    if (submission.product === 'insurance') {
      let extraction = null;
      try {
        extraction = await extractInsuranceDocuments(ANTHROPIC_API_KEY, contentBlocks);
      } catch (err) {
        console.error('[insurance] extraction failed:', err.message);
      }

      const audited = extraction
        ? runInsuranceAudit(extraction)
        : { findings: [], skipped: [], checksRun: 0, checksTotal: 0, comparisonAvailable: false, priorPremiumSource: null };
      insuranceAnalysis = audited;

      if (extraction) {
        const ranked = rankInsuranceFindings(audited.findings);
        const flagged = ranked.filter((f) => f.category !== InsuranceCategory.WITHIN_NORMS);
        const passed = ranked.filter((f) => f.category === InsuranceCategory.WITHIN_NORMS);

        auditBlock = [
          '',
          'FINDINGS — these are the report. Write these up. Do not add to them, do not recompute',
          'one, and do not change a category. Every figure and judgement you may state is here.',
          JSON.stringify(flagged, null, 1),
          '',
          passed.length
            ? [
              `CHECKS THAT RAN AND FOUND NOTHING TO FLAG — ${passed.length} of them, below.`,
              'These belong in their own short section. Each is a check that ran on the customer\'s',
              'own documents and came back clean, which is work they paid for even when — especially',
              'when — there is nothing to act on.',
              JSON.stringify(passed.map((f) => ({ title: f.title, basis: f.basis })), null, 1),
            ].join('\n')
            : '',
          '',
          audited.comparisonAvailable
            ? `COVERAGE — ${audited.checksRun} of ${audited.checksTotal} possible checks ran on these documents `
              + (audited.priorPremiumSource === 'renewal_notice_stated'
                ? '(the prior premium came from the renewal notice\'s own stated figure, not a second document — say so once, plainly, and note that only the premium comparison could run without the prior policy itself).'
                : '(both the renewal notice and a prior policy were read).')
            : 'NO COMPARISON COULD BE MADE. Neither a prior policy nor a prior-premium figure printed on the '
              + 'renewal notice was available, so the core comparison this product is built on did not run. Say '
              + 'this first and plainly, and do not render any verdict on the renewal by itself.',
          '',
          audited.skipped.length
            ? `Checks that could not be run because the required figures were missing or unreadable: ${audited.skipped.join('; ')}. Say so plainly rather than implying they passed.`
            : '',
        ].filter(Boolean).join('\n');
      } else {
        // Extraction failed outright — a photograph too dark to read, or an
        // attachment that turned out not to be an insurance document. The
        // customer has still paid, and a thinner analysis they are told is
        // thinner beats an empty report.
        auditBlock = [
          '',
          'THE UPLOADED DOCUMENTS COULD NOT BE READ INTO FIGURES precisely enough for the audit engine',
          'to run a single check. Say that plainly and early, in the summary and again in',
          'missing_or_uncertain: no verdict could be reached, and this should be treated as a starting',
          'point, not a comparison. Tell the customer exactly what would fix it — a clearer scan or the',
          'original PDF of their renewal notice and prior policy, rather than a photograph.',
        ].join('\n');
      }
    }

    // Home Maintenance Navigator. Same shape and same reason as Insurance
    // above: the verdict is computed by navigator-home-maintenance-engine.js
    // from the structured answers the customer gave, and the model presents
    // it. Any uploaded quote/photos are still attached — the writer may
    // quote them — but nothing it reads in them may become or change the
    // verdict, the cost comparison, or the lifespan context.
    let homeMaintenanceAnalysis = null;
    if (submission.product === 'home-maintenance') {
      const sufficiency = homeMaintenanceEngine.checkSufficiency(formData);
      if (sufficiency.sufficient) {
        homeMaintenanceAnalysis = homeMaintenanceEngine.analyze(formData);
        const a = homeMaintenanceAnalysis;
        const V = homeMaintenanceEngine.Verdict;

        auditBlock = [
          '',
          'DECISION — this is the report. Write it up. Do not add to it, do not recompute it, and',
          'do not change the verdict.',
          JSON.stringify({
            category: a.category,
            verdict: a.verdict,
            reasons: a.reasons,
            costComparison: a.costComparison,
            cautions: a.cautions,
          }, null, 1),
          '',
          a.verdict === V.URGENT_SAFETY
            ? [
              'THIS IS A SAFETY VERDICT. The headline and summary must lead with the safety guidance',
              'above, in full, before anything else. Do not produce a repair-vs-replace comparison, a',
              'cost figure, or a lifespan-context section on this report — none of that is relevant',
              'until the hazard itself is addressed, and including it would bury the one thing this',
              'report needs to say.',
            ].join('\n')
            : '',
          a.ageContext
            ? [
              '',
              a.ageContext.materialSpecific
                // docs/HOME-MAINTENANCE-ENGINE-AUDIT-REPORT.md, Required
                // Changes (High) #4: when the customer named their actual
                // material/type, the range is specific to it and may be
                // stated as such rather than hedged with the "most common
                // material" caveat that only applies to the unconfirmed
                // default.
                ? `AGE CONTEXT — for a ${a.category.toLowerCase()} of this material/type, the typical `
                  + `service-life range is ${a.ageContext.range.low}-${a.ageContext.range.high} years `
                  + `(${a.ageContext.range.caveat}).`
                : `AGE CONTEXT — for ${a.category}, the typical service-life range is `
                  + `${a.ageContext.range.low}-${a.ageContext.range.high} years (${a.ageContext.range.caveat}). `
                  + 'The customer did not confirm the material/type, so this is the default range for the '
                  + 'most common one — say so plainly rather than stating it as if it were confirmed.',
              a.ageContext.ageYears !== null
                ? `This system is ${a.ageContext.ageYears} years old, which is `
                  + `${a.ageContext.pastTypicalRange ? 'past' : (a.ageContext.withinTypicalRange ? 'within' : 'before')} `
                  + 'that range.'
                : 'The age was not given, so state the range as general context only — do not say where this system falls in it.',
              'Give this its own short section. State the range and its caveat exactly as given here,',
              'and never imply it is a fact about this specific unit rather than a general range for the category.',
            ].join('\n')
            : `AGE CONTEXT — none. ${a.category === 'Other' ? 'There is no single typical range for an unnamed system category.' : 'The age was not given.'} Do not invent one.`,
          '',
          `CHECKLIST — practical questions to ask a contractor, not a finding:`,
          JSON.stringify(a.checklist, null, 1),
          (a.verdict === V.NEED_REPAIR_QUOTE || a.verdict === V.NEED_REPLACEMENT_QUOTE || a.verdict === V.NEED_BOTH_QUOTES)
            // docs/HOME-MAINTENANCE-ENGINE-AUDIT-REPORT.md, Required Changes
            // (Medium) #5: naming what's missing is not the same as helping
            // the customer go get it. This does not invent a cost or a
            // timeline — it points at the checklist item already computed
            // above that speaks to getting more than one quote.
            ? [
              '',
              'This customer does not yet have enough of their own numbers for a financial verdict. Beyond',
              'naming exactly what is missing, close this section by pointing them at the checklist above —',
              'specifically, the reminder to get at least one more quote — as the concrete next step that',
              'gets them a verdict. Do not estimate what the missing figure is likely to be.',
            ].join('\n')
            : '',
        ].filter(Boolean).join('\n');
      } else {
        // The intake gate blocks this client- and server-side, so reaching
        // here means something upstream let a blank submission through. Say
        // so rather than falling back to a general article about home
        // maintenance, which is not what was paid for.
        auditBlock = [
          '',
          'THIS SUBMISSION IS MISSING REQUIRED ANSWERS, so no verdict could be computed. Say that first,',
          'plainly, in the summary and again in missing_or_uncertain, and name exactly what is missing:',
          JSON.stringify(sufficiency.missing.map((m) => m.label), null, 1),
          'Do not produce general advice about home maintenance in its place. Tell them to reply to',
          'their receipt with the missing answers and the review will be run.',
        ].join('\n');
      }
    }

    // Property Tax Navigator. Same shape and same reason as Insurance and
    // Home Maintenance above: the findings are computed by
    // navigator-property-tax-engine.js from the structured answers the
    // homeowner gave, and the model presents them. Nothing it reads in an
    // uploaded assessment notice may become or change a finding — files
    // remain attached only so the writer can quote them.
    let propertyTaxAnalysis = null;
    if (submission.product === 'property-tax') {
      const sufficiency = propertyTaxEngine.checkSufficiency(formData);
      if (sufficiency.sufficient) {
        propertyTaxAnalysis = propertyTaxEngine.analyze(formData);
        const a = propertyTaxAnalysis;
        const flagged = a.findings.filter((f) => f.category !== propertyTaxEngine.Category.WITHIN_NORMS);
        const passed = a.findings.filter((f) => f.category === propertyTaxEngine.Category.WITHIN_NORMS);

        auditBlock = [
          '',
          'FINDINGS — these are the report. Write them up. Do not add to them, do not recompute one,',
          'and do not change a category. Every figure and comparable you may state is here.',
          JSON.stringify(flagged, null, 1),
          '',
          passed.length
            ? [
              `CHECKS THAT RAN AND FOUND NOTHING TO FLAG — ${passed.length} of them, below.`,
              'These belong in their own short section — a check that ran on the homeowner\'s own figures',
              'and came back clean is still work they paid for.',
              JSON.stringify(passed.map((f) => ({ title: f.title, basis: f.basis })), null, 1),
            ].join('\n')
            : '',
          '',
          a.hasBaseline
            ? ''
            : 'NO COMPARISON COULD BE MADE. Say this first and plainly, and do not render any verdict on the '
              + 'current assessment by itself — see the COMPARISON_NOT_POSSIBLE finding above for exactly what to ask for.',
        ].filter(Boolean).join('\n');
      } else {
        // The intake gate blocks this client- and server-side, so reaching
        // here means something upstream let a blank submission through.
        auditBlock = [
          '',
          'THIS SUBMISSION IS MISSING REQUIRED ANSWERS, so no finding could be computed. Say that first,',
          'plainly, in the summary and again in missing_or_uncertain, and name exactly what is missing:',
          JSON.stringify(sufficiency.missing.map((m) => m.label), null, 1),
          'Do not produce a general article about property tax appeals in its place. Tell them to reply',
          'to their receipt with the missing answers and the review will be run.',
        ].join('\n');
      }
    }

    // The pre-engine prompt, used only on the fallback path above. It is the
    // weaker product and the report has to say so rather than passing an
    // unverified read off as an audit.
    const FALLBACK_RENTAL_TASK = `You are the analysis engine behind Rental Navigator. A landlord paid for a cash-flow audit and uploaded documents, but the documents could not be read into figures precisely enough for the audit engine to run a single check on them.

Say that plainly and early, in the summary and again in missing_or_uncertain: the numbers could not be extracted, so what follows is a read of the documents rather than the arithmetic audit that was paid for, and it should be treated as a starting point. Tell them exactly what would fix it — a clearer scan, the original PDF export from their property management system rather than a photograph, or the statement pages that carry the totals.

Then do what you can. Work only from what is legibly present, flag anything that looks abnormal or above a typical range, and never state a figure you cannot point at in the documents. Do not present any of it as verified.`;

    const taskForThisRun = usedFallbackAnalysis ? FALLBACK_RENTAL_TASK : config.task;
    const systemPrompt = `${taskForThisRun}\n\n${HONESTY_RULES}${auditBlock}\n\nRespond ONLY by calling the submit_navigator_report tool.`;

    // Occasionally the model's structured tool-call output gets corrupted —
    // observed in testing as a stray closing tag / parameter fragment (e.g.
    // "</summary>\n<parameter name=\"key_numbers\">...") leaking into a
    // text field instead of populating the actual key_numbers field. The
    // JSON still parses fine, so this wouldn't be caught by a JSON.parse
    // check — it silently ships a broken-looking report to a paying
    // customer. Detect it and retry the whole generation once before
    // giving up, rather than surfacing garbled tags to a customer.
    const TAG_LEAK_PATTERN = /<\/?[a-zA-Z][a-zA-Z0-9_-]*(\s[^>]*)?>/;
    function reportLooksContaminated(value) {
      if (typeof value === 'string') return TAG_LEAK_PATTERN.test(value);
      if (Array.isArray(value)) return value.some(reportLooksContaminated);
      if (value && typeof value === 'object') return Object.values(value).some(reportLooksContaminated);
      return false;
    }

    const MAX_ATTEMPTS = 2;
    let report = null;
    let lastError = null;
    // The output ceiling is sized to the work, not fixed.
    //
    // 8000 was a flat number, and the comment beside it already conceded that
    // "a closing audit with twenty findings plus two drafted emails runs close
    // to that ceiling". Landlord Navigator made that concrete and worse:
    // twelve properties — the maximum the intake accepts, and exactly the
    // customer a flat $149 suits best — produce 76 deterministic findings,
    // which at any honest length per finding cannot be written inside 8000
    // tokens. The report would truncate, and truncation throws, so the
    // largest-paying portfolio was the one guaranteed to fail.
    //
    // maxTokensForWork scales with the size of the findings actually handed
    // over, which works the same way for a closing audit, a rental audit and a
    // landlord portfolio because all three arrive as the same auditBlock.
    let maxTokens = maxTokensForWork(auditBlock);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !report; attempt++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: maxTokens,
          system: systemPrompt,
          tools: [REPORT_TOOL],
          tool_choice: { type: 'tool', name: 'submit_navigator_report' },
          messages: [{ role: 'user', content: contentBlocks }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Anthropic API error ${response.status}: ${errText.slice(0, 500)}`);
      }

      const data = await response.json();

      // A truncated response still parses. Without this, a report cut off

      // mid-sentence is stored and emailed as though it were complete.

      // A truncated response still parses. Without this check, a report cut off
      // mid-sentence is stored, emailed and billed as though it were complete.
      //
      // What it must NOT do is give up, which is what a bare throw here did:
      // it exits the retry loop entirely, so the first truncation was fatal and
      // the second attempt the loop exists for never happened. Retrying at the
      // same ceiling would only truncate again, so the retry raises it.
      if (data.stop_reason === 'max_tokens') {
        lastError = new Error('Report generation hit the output limit and was truncated — not saved.');
        maxTokens = Math.min(Math.round(maxTokens * 2), HARD_MAX_TOKENS);
        continue;
      }
      const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_navigator_report');
      if (!toolUse) {
        lastError = new Error('Model did not return a structured report');
        continue;
      }

      // Normalised BEFORE the contamination check so the check reads the same
      // strings the customer will, not a container the renderer would reject.
      const candidate = normalizeReport(toolUse.input);

      if (reportLooksContaminated(candidate)) {
        lastError = new Error('Model output contained malformed/leaked formatting artifacts');
        continue;
      }

      // A report with no sections is not a report. Retrying costs a minute;
      // storing an empty one costs the customer the whole purchase.
      if (!candidate.sections.length) {
        lastError = new Error('Model returned a report with no sections');
        continue;
      }

      report = candidate;
    }

    if (!report) throw lastError || new Error('Failed to generate a valid report after retrying');

    // Did the write-up state a figure the audit never computed?
    //
    // The prompt has always forbidden it. Nothing checked, and on /buying the
    // identical instruction produced a headline total that disagreed with its
    // own line items, a fuel cost stated twice about $3,000 apart, and a resale
    // figure out by a factor of two. An instruction is not a mechanism.
    //
    // This does not rewrite the report. Closing's findings are computed, so a
    // figure that matches nothing is far more likely to be the model quoting
    // the document in a way the checker does not recognise than a hallucinated
    // dollar amount — and silently deleting a customer's sentence on that basis
    // would be worse than the problem. It is logged and recorded, so a pattern
    // shows up in one place instead of one report at a time.
    // The engine's own decisions, attached to the stored report so the ledger
    // on navigator-status.html renders from the arithmetic rather than from
    // the prose written about it. A figure shown to the customer and a figure
    // the engine computed must be the same figure.
    if (submission.product === 'subscriptions' && subscriptionAnalysis) {
      report.subscription_analysis = subscriptionAnalysis;
    }

    if (submission.product === 'insurance' && insuranceAnalysis) {
      report.insurance_analysis = insuranceAnalysis;
    }

    if (submission.product === 'home-maintenance' && homeMaintenanceAnalysis) {
      report.home_maintenance_analysis = homeMaintenanceAnalysis;

      // docs/HOME-MAINTENANCE-ENGINE-AUDIT-REPORT.md, Required Changes
      // (Critical) #1: NEED_BOTH_QUOTES is the one outcome this product
      // explicitly, deliberately sells — "honestly scoped, not blocked," per
      // this engine's own test suite — where the customer receives no
      // financial verdict at all, only a category checklist and (at most) a
      // boilerplate age sentence. Nothing computed here is specific to this
      // customer's situation beyond echoing their own category/age back to
      // them. Same queue Government Money Finder uses for the identical
      // shape of problem (api/_lib/navigator-engine.js, government-money
      // block above, `refund_state: 'due_thin_result'`, picked up by
      // api/process-refunds.js's existing REFUND_STATE_THIN queue) — the
      // row stays 'complete', the report exists, the customer keeps it, and
      // they do not pay for it.
      //
      // Deliberately NOT triggered by NEED_REPAIR_QUOTE or
      // NEED_REPLACEMENT_QUOTE: those customers gave one real quote and get
      // a concrete, single-item next step to complete their own comparison,
      // which is real value received for the charge.
      if (homeMaintenanceAnalysis.verdict === homeMaintenanceEngine.Verdict.NEED_BOTH_QUOTES) {
        try {
          await admin
            .from('navigator_submissions')
            .update({ refund_state: 'due_thin_result', updated_at: new Date().toISOString() })
            .eq('id', submissionId);
        } catch (err) {
          console.error('[home-maintenance] could not queue the refund:', err.message);
        }
      }
    }

    if (submission.product === 'property-tax' && propertyTaxAnalysis) {
      report.property_tax_analysis = propertyTaxAnalysis;
    }

    // Stored so the customer's NEXT shortlist can say what moved. Verdicts only —
    // there are no amounts in this product, and a comparison is about what opened
    // and what closed.
    if (submission.product === 'government-money' && governmentMoneyAnalysis) {
      report.government_money_analysis = governmentMoneyAnalysis;
      try {
        await admin
          .from('navigator_submissions')
          .update({
            form_data: Object.assign({}, submission.form_data || {}, {
              government_money_verdicts: governmentMoneyEngine.storableVerdicts(governmentMoneyAnalysis),
            }),
          })
          .eq('id', submissionId);
      } catch (err) {
        // A re-check that cannot be set up must never cost this customer the
        // report they already paid for.
        console.error('[government-money] could not store verdicts:', err.message);
      }

      // Nothing at all came back — no shortlist and nothing even worth
      // confirming — so the charge goes back without anybody having to ask.
      //
      // Same queue Contractor Navigator uses when too few checks could run on
      // the documents (REFUND_STATE_THIN in api/process-refunds.js): the row is
      // 'complete', the report exists, the customer keeps it, and they do not
      // pay for it. The page promises a refund when there is nothing worth
      // acting on, and this is the half of that promise a customer should never
      // have to claim. The judgement cases — a shortlist that exists but does
      // not suit them — still go through replying to the delivery email.
      //
      // Deliberately NOT triggered by an empty shortlist alone. A report with
      // no claims but eight lines worth confirming is a report that did its job.
      if (governmentMoneyAnalysis.totals.shortlist === 0
        && governmentMoneyAnalysis.totals.toConfirm === 0) {
        try {
          await admin
            .from('navigator_submissions')
            .update({ refund_state: 'due_thin_result', updated_at: new Date().toISOString() })
            .eq('id', submissionId);
        } catch (err) {
          console.error('[government-money] could not queue the refund:', err.message);
        }
      }
    }

    if (submission.product === 'closing' && closingFindings) {
      try {
        const { problems, totalImpact } = checkClosingConsistency({
          report,
          findings: closingFindings,
          extraction: closingExtraction,
        });
        report.audit_total_impact = totalImpact;
        if (problems.length) {
          report.consistency_problems = problems;
          problems.forEach((p) => {
            console.warn(`[closing] submission ${submissionId}: ${p.class} — ${p.message}`);
          });
        }
      } catch (err) {
        // A checker that throws must never cost a customer their report. That
        // is the whole lesson of the five times this checker was wrong.
        console.error('[closing] consistency check failed:', err.message);
      }
    }

    // Attached after generation, never before: the letters are assembled from
    // the audit's own figures and must not pass through the model, which is
    // here to write up findings, not to reword a letter the customer will sign
    // their name to. Attaching after also keeps them clear of the contamination
    // check above, which is looking for model output, not our own text.
    // Landlord's equivalent: the action pack, assembled from the audit's own
    // findings and attached here rather than written by the model. Same reason
    // as the letters below — this is a document the customer works through, and
    // a writer that reworded it could turn a requirement into a suggestion. It
    // replaces whatever closing block the model produced.
    if (landlordPack) {
      report.closing_title = 'Your action pack, property by property';
      report.closing_body = landlordPack;
    }

    const hasLetters = draftedEmails
      && Object.values(draftedEmails).some((letter) => letter && letter.body);
    if (hasLetters) {
      report.emails = draftedEmails;

      // And they replace closing_body, for exactly the reason above.
      //
      // The customer was getting two different versions of the same letters:
      // api/_lib/pdf-report.js renders report.emails into the PDF, while
      // navigator-status.html renders closing_body, which the model writes
      // itself. On the paid report for submission c764be16 the two differed
      // in subject, tone and wording — the deterministic letter opened "I may
      // well be reading something wrong, so I would appreciate your help
      // squaring these up", the model's opened "I've had my Closing
      // Disclosure independently audited" under a subject reading "Three
      // Items Requiring Correction".
      //
      // Both are letters the customer signs their name to and sends to their
      // own lender, and the tone of those is not a detail. The voice fix made
      // to closing-emails.js on 2026-09-08 reached only the PDF copy, because
      // nobody had noticed there were two.
      const rendered = submission.product === 'rental'
        ? renderRentalLetters(draftedEmails)
        : renderLettersAsText(draftedEmails);
      if (rendered) {
        report.closing_title = 'Ready-to-send emails';
        report.closing_body = rendered;
      }
    }

    await admin.from('navigator_reports').insert({
      submission_id: submissionId,
      product: submission.product,
      report_json: report,
      model: ANTHROPIC_MODEL,
    });

    await admin
      .from('navigator_submissions')
      .update({ status: 'complete', updated_at: new Date().toISOString() })
      .eq('id', submissionId);

    // The year starts when the report lands, not when the payment clears — a
    // customer whose first report failed and was regenerated the next morning
    // has not spent a day of it. Granted after the report is stored so a
    // generation that dies before this point leaves nothing behind to reconcile.
    if (submission.product === 'rental') {
      await grantEntitlement(admin, submission, rentalExtraction);
    }

    // Landlord grants the same year, for the reason the reminder exists: a
    // registration renews and a notice window opens on a date, and a report
    // that names the date without ever coming back to it has done half the job.
    // The address recorded is the first property's, purely so the reminder mail
    // and the entitlement row are recognisable — every property is carried on
    // the submission itself and api/landlord-reminders.js reads them all.
    if (submission.product === 'landlord') {
      const first = (Array.isArray(formData.properties) ? formData.properties : [])[0] || {};
      const where = [first.label || first.line1, first.city, first.state].filter(Boolean).join(', ');
      await grantEntitlement(admin, submission, { property: { address: where || null } });
    }

    return report;
  } catch (err) {
    // Failing loudly, and paying the money back.
    //
    // Until this block did both, a report that died here left a row reading
    // 'failed' and nothing else. No alert reached anyone — api/_lib/alerts.js
    // was wired into the HOA and Purchase engines only — and no refund was
    // queued, because api/process-refunds.js acts on refund_state='due' and
    // only api/_lib/hoa-engine.js ever set it. The customer was shown "no
    // charge is lost", which was true only if they happened to email in and
    // somebody happened to act on it.
    //
    // The audit of 2026-09-10 found this the direct way: a live submission was
    // put through the real path, the Anthropic account turned out to be out of
    // credit, and the failure produced silence. Nine products run through this
    // function. Every one of them had the same hole.
    //
    // The refund is queued only where a Stripe session actually exists, so a
    // submission that never paid — a test row, or one abandoned at checkout —
    // cannot queue money it never took. process-refunds re-checks that and
    // three other conditions before a cent moves, including that no report was
    // ever delivered for this submission.
    // And NOT refunding an outage. See api/_lib/provider-outage.js: an account
    // out of credit, a rate limit or a 5xx says nothing about this submission,
    // so the row goes back to 'paid' for the five-minute sweep to retry rather
    // than to 'failed' with the customer's money on its way back out.
    const paidForReal = !!submission.stripe_checkout_session_id;
    const { outage, patch } = failurePatch(err, { paidForReal, waitingSince: submission.created_at });

    await admin.from('navigator_submissions').update(patch).eq('id', submissionId);

    // One alert per submission per distinct cause, not one per attempt. During
    // an outage the sweep retries three rows every five minutes, and an alarm
    // that sends forty identical emails an hour is one nobody reads by the
    // second hour — which is the state the original silence was preferable to.
    const alreadyReported = submission.error === patch.error;

    // Never allowed to mask the original failure: an alert that cannot be sent
    // is a worse alert, not a worse report.
    if (!alreadyReported) {
      try {
        await sendFailureAlert({
          submissionId,
          product: submission.product,
          error: patch.error,
          refundQueued: patch.refund_state === 'due',
          paused: outage,
        });
      } catch (alertError) {
        console.error('[navigator] failure alert could not be sent:', alertError.message);
      }
    }

    throw err;
  }
}

module.exports = {
  generateNavigatorReport,
  PRODUCT_CONFIGS,
  __internal: {
    renderLettersAsText, normalizeReport, coerceStringArray,
    maxTokensForWork, BASE_MAX_TOKENS, HARD_MAX_TOKENS,
  },
};
