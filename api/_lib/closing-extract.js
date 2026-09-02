// Closing Disclosure extraction + audit orchestration.
//
// Split of responsibility, and the reason this file exists:
//   * The model EXTRACTS. It reads the PDF and reports what is printed on it,
//     with a confidence score per field. It does not judge anything.
//   * closing-audit.js DECIDES. Every flag, dollar figure, threshold and
//     severity comes from deterministic code with a citable basis.
//   * The model then WRITES UP the decisions (see navigator-engine.js).
//
// Keeping extraction and judgment apart is the whole point. A model asked to do
// both will quietly fill a gap in the first with a plausible guess and then
// reason from it.

'use strict';

const audit = require('./closing-audit');
const { makeGetBenchmark } = require('./benchmark-corpus');

// Loaded once per cold start. If the corpus file is malformed the corpus refuses
// to load entirely and every fee falls back to "cannot benchmark" — the safe
// direction. A broken corpus must never half-answer.
let defaultGetBenchmark = () => null;
try {
  const corpus = require('../../data/benchmarks.json');
  defaultGetBenchmark = makeGetBenchmark(corpus.rows || []);
} catch (err) {
  console.error('[benchmarks] corpus unavailable, all fees will report cannot-benchmark:', err.message);
}

const ANTHROPIC_MODEL = 'claude-sonnet-5';

// ---------------------------------------------------------------------------
// extraction tool
// ---------------------------------------------------------------------------

const CONFIDENCE_DESC =
  'Your confidence that you read this value correctly, 0 to 1. Below 0.85 the value is ' +
  'discarded rather than used. Score honestly — a low score costs the customer a re-upload, ' +
  'a wrong value costs them money. If the figure is faint, cropped, ambiguous, or you are ' +
  'inferring it rather than reading it, score it below 0.85.';

const amountField = (desc) => ({
  type: 'object',
  description: desc,
  properties: {
    value: { type: 'number', description: 'The dollar amount as printed, no currency symbol.' },
    confidence: { type: 'number', description: CONFIDENCE_DESC },
    page: { type: 'number', description: 'Page number this was read from.' },
  },
  required: ['value', 'confidence', 'page'],
});

const EXTRACTION_TOOL = {
  name: 'submit_cd_extraction',
  description:
    'Report every value printed on this Closing Disclosure. Report only what is on the ' +
    'document. Never compute a missing value from other values, never carry a figure over ' +
    'from a different document, and never supply a typical or expected amount. If something ' +
    'is absent, omit it.',
  input_schema: {
    type: 'object',
    properties: {
      document_type: {
        type: 'string',
        enum: [
          'closing_disclosure', 'alta_settlement_statement', 'loan_estimate',
          'purchase_contract', 'other',
        ],
        description:
          'What this document actually is. Customers mislabel uploads routinely — an ALTA ' +
          'Settlement Statement is the title company\'s own form and is frequently mistaken for ' +
          'the Closing Disclosure. Report what it IS; both are usable here.',
      },
      is_final: {
        type: 'boolean',
        description: 'True if this appears to be the final Closing Disclosure rather than a preliminary or corrected one.',
      },
      property_address: { type: 'string' },
      property_state: { type: 'string', description: 'Two-letter state code from the property address.' },
      property_county: { type: 'string' },
      transaction_type: { type: 'string', enum: ['purchase', 'refinance', 'other'] },
      closing_date: { type: 'string', description: 'Closing/disbursement date as YYYY-MM-DD.' },
      loan_amount: { type: 'number' },
      sale_price: {
        type: 'number',
        description: 'Sale price / contract price from page 1 or the summaries of transactions. '
          + 'Transfer and recordation taxes are computed on this, not on the loan amount.',
      },
      interest_rate_pct: { type: 'number', description: 'Note rate as a percentage, e.g. 6.5 for 6.5%.' },
      loan_term_years: { type: 'number' },

      line_items: {
        type: 'array',
        description:
          'Every INDIVIDUAL charge line on pages 2 and 3, in document order. One entry per printed ' +
          'numbered line, including lines with a zero or blank borrower amount.\n\n' +
          'Do NOT include section headings or subtotals. These are not charges and reporting them ' +
          'as charges causes real errors: a subtotal has been benchmarked as if it were a single ' +
          'fee, and a section total has been counted twice against the customer.\n' +
          'Exclude, for example: "A. Origination Charges", "B. Services Borrower Did Not Shop For", ' +
          '"C. Services Borrower Did Shop For", "D. TOTAL LOAN COSTS", "E. Taxes and Other ' +
          'Government Fees", "F. Prepaids", "G. Initial Escrow Payment at Closing", "H. Other", ' +
          '"I. TOTAL OTHER COSTS", "J. TOTAL CLOSING COSTS", "K. TOTAL PAYOFFS AND PAYMENTS", and ' +
          'any "Subtotals" line. Those belong in section_totals, not here.\n' +
          'Also exclude payoff rows from the Payoffs and Payments table — they are not closing costs.\n' +
          'A line qualifies here only if it has its own two-digit number (01, 02, 03...) beside it.',
        items: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              enum: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'none'],
              description:
                'The lettered section this line sits under. Use "none" for documents that have no ' +
                'lettered sections, such as an ALTA Settlement Statement.',
            },
            label: { type: 'string', description: 'The fee name exactly as printed.' },
            amount: { type: 'number', description: 'Amount in the borrower-at-closing column.' },
            payee: { type: 'string', description: 'The "to [provider]" name, if printed.' },
            paid_by: { type: 'string', enum: ['borrower', 'seller', 'other', 'lender'] },
            paid_before_closing: { type: 'boolean' },
            category: {
              type: 'string',
              enum: [
                'origination', 'lender_fee', 'credit_report', 'rate_lock_fee', 'appraisal',
                'settlement_service', 'title_insurance_owners', 'title_insurance_lenders',
                'survey', 'attorney', 'recording_fee', 'transfer_tax', 'prepaid_interest',
                'property_insurance', 'property_tax', 'escrow_deposit', 'hoa_dues',
                'optional_product', 'non_required_service', 'affiliate_service',
                'unshoppable_service', 'other',
              ],
              description:
                'Best classification of what kind of charge this is. This drives which ' +
                'tolerance rule applies, so classify by what the fee IS, not by which section ' +
                'it happens to be printed in.',
            },
            shoppable: {
              type: 'boolean',
              description: 'True if this line appears under Section C (services the borrower did shop for).',
            },
            confidence: { type: 'number', description: CONFIDENCE_DESC },
            page: { type: 'number' },
          },
          required: ['section', 'label', 'amount', 'confidence', 'page'],
        },
      },

      section_totals: {
        type: 'object',
        description: 'The printed subtotals. Report what is printed even if it looks wrong — that is exactly what we are checking.',
        properties: {
          A: amountField('Section A total'), B: amountField('Section B total'),
          C: amountField('Section C total'), D: amountField('Section D, Total Loan Costs'),
          E: amountField('Section E total'), F: amountField('Section F total'),
          G: amountField('Section G total'), H: amountField('Section H total'),
          I: amountField('Section I, Total Other Costs'),
          J: amountField('Section J, Total Closing Costs'),
          lender_credits: amountField('Lender credits, as a positive number'),
        },
      },

      cash_to_close: {
        type: 'object',
        description: 'The Calculating Cash to Close table on page 3.',
        properties: {
          total_closing_costs_j: amountField('Total closing costs (J)'),
          total_payoffs_and_payments: amountField(
            'Total Payoffs and Payments (K). Appears on the ALTERNATIVE Cash to Close table, '
            + 'used for refinances. Omit entirely on a purchase.'),
          closing_costs_paid_before_closing: amountField('Closing costs paid before closing'),
          down_payment_funds_from_borrower: amountField('Down payment / funds from borrower'),
          deposit: amountField('Deposit, as a positive number'),
          funds_for_borrower: amountField('Funds for borrower, as a positive number'),
          seller_credits: amountField('Seller credits, as a positive number'),
          adjustments_and_other_credits: amountField('Adjustments and other credits, as a positive number'),
          stated_cash_to_close: amountField('Cash to Close as printed'),
        },
      },

      prepaid_interest: {
        type: 'object',
        description: 'The prepaid interest line in Section F.',
        properties: {
          amount: { type: 'number' },
          days: { type: 'number', description: 'Number of days as printed on the line, if stated.' },
          per_diem: { type: 'number', description: 'Per-day amount as printed, if stated.' },
          confidence: { type: 'number', description: CONFIDENCE_DESC },
          page: { type: 'number' },
        },
      },

      escrow: {
        type: 'object',
        description: 'Section G, initial escrow payment at closing, plus page 4 escrow detail.',
        properties: {
          annual_disbursements: {
            type: 'array',
            description: 'Each escrowed item and its estimated ANNUAL total, from the escrow account section on page 4.',
            items: {
              type: 'object',
              properties: {
                item: { type: 'string' },
                annual_amount: { type: 'number' },
                confidence: { type: 'number', description: CONFIDENCE_DESC },
              },
              required: ['item', 'annual_amount', 'confidence'],
            },
          },
          cushion_amount: {
            type: 'number',
            description: 'ONLY the cushion, if the document states one separately. This is NOT the '
              + 'Section G total and NOT the aggregate adjustment. Most Closing Disclosures do not '
              + 'state a cushion separately — in that case omit this field entirely rather than '
              + 'substituting another number.',
          },
          aggregate_adjustment: {
            type: 'number',
            description: 'The aggregate adjustment line in Section G, as printed (normally negative).',
          },
          section_g_total: { type: 'number', description: 'Section G total initial escrow payment at closing.' },
          cushion_confidence: { type: 'number', description: CONFIDENCE_DESC },
        },
      },

      prorations: {
        type: 'array',
        description: 'Tax, HOA, or other prorated adjustments, from Section K/L or the adjustments lines.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            annual_amount: { type: 'number', description: 'The full-period amount being prorated, if stated.' },
            period_start: { type: 'string', description: 'YYYY-MM-DD' },
            period_end: { type: 'string', description: 'YYYY-MM-DD' },
            charged_amount: { type: 'number' },
            payer: { type: 'string', enum: ['buyer', 'seller'] },
            confidence: { type: 'number', description: CONFIDENCE_DESC },
          },
          required: ['label', 'charged_amount', 'confidence'],
        },
      },

      seller_credits_on_cd: {
        type: 'array',
        description: 'Any seller credit, concession, or repair credit lines, for reconciliation against the purchase contract.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            amount: { type: 'number' },
            confidence: { type: 'number', description: CONFIDENCE_DESC },
          },
          required: ['label', 'amount', 'confidence'],
        },
      },

      pages_present: { type: 'number', description: 'How many pages you could actually read.' },
      document_problems: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Anything wrong with the document itself: missing pages, cropped scans, illegible ' +
          'sections, a page that appears to be from a different loan. Be specific about which page.',
      },
    },
    required: ['document_type', 'line_items', 'pages_present'],
  },
};

const EXTRACTION_SYSTEM = `You are an extraction engine for mortgage closing documents. You read documents and report exactly what is printed on them.

You do not analyze, judge, compare, or advise. Something else does that with what you report.

Absolute rules:
- Report only values that are physically printed on the document. Never compute a value that is missing by deriving it from other values. Never fill in a typical or expected amount. Never carry a figure across from a different document.
- If a subtotal looks arithmetically wrong, report it as printed anyway. Detecting that is the entire point of the system you are feeding.
- Score confidence honestly on every field. A value below 0.85 confidence is discarded and the customer is asked for a clearer copy. That is a far better outcome than a confident wrong number, which becomes a dollar figure in a report the customer sends to their lender.
- If a document is not a Closing Disclosure, say so in document_type rather than trying to force its contents into this shape. An ALTA Settlement Statement is fully usable — report its charge lines, payees and prorations with section "none", and leave the CD-only fields (section_totals, cash_to_close, escrow) out rather than inventing them.
- Use document_problems generously. Missing pages and cropped scans are common and matter.

Respond ONLY by calling the submit_cd_extraction tool.`;

async function callAnthropic({ apiKey, system, tools, contentBlocks, maxTokens = 8000 }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      tools,
      tool_choice: { type: 'tool', name: tools[0].name },
      messages: [{ role: 'user', content: contentBlocks }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${errText.slice(0, 400)}`);
  }

  const data = await response.json();
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
  if (!toolUse || !toolUse.input) throw new Error('Model did not return a tool call.');
  return toolUse.input;
}

// ---------------------------------------------------------------------------
// document classification + pricing tier
// ---------------------------------------------------------------------------

// Cheap first pass over a multi-file upload. Full extraction of every document
// at the free stage would multiply the model cost on an unauthenticated
// endpoint; this returns only a type per file, so we can extract the Closing
// Disclosure properly and defer the rest until after payment, which is when the
// tolerance and contract analyses actually run.
const CLASSIFY_TOOL = {
  name: 'classify_documents',
  description: 'Identify what each uploaded document is. Report only what you see.',
  input_schema: {
    type: 'object',
    properties: {
      documents: {
        type: 'array',
        description: 'One entry per document, in the order supplied.',
        items: {
          type: 'object',
          properties: {
            index: { type: 'number', description: 'Zero-based position in the upload.' },
            document_type: {
              type: 'string',
              enum: [
                'closing_disclosure', 'alta_settlement_statement', 'loan_estimate',
                'purchase_contract', 'other',
              ],
            },
            note: { type: 'string', description: 'A few words on what it appears to be.' },
          },
          required: ['index', 'document_type'],
        },
      },
    },
    required: ['documents'],
  },
};

async function classifyDocuments(apiKey, perFileBlocks) {
  const content = [];
  perFileBlocks.forEach((block, i) => {
    content.push({ type: 'text', text: `Document ${i}:` });
    content.push(block);
  });
  content.push({ type: 'text', text: 'Identify each document.' });

  const result = await callAnthropic({
    apiKey,
    system: 'You identify mortgage closing documents. Report what each one is. Do not analyse them.',
    tools: [CLASSIFY_TOOL],
    contentBlocks: content,
    maxTokens: 1000,
  });
  return result.documents || [];
}

const PRIMARY_TYPES = ['closing_disclosure', 'alta_settlement_statement'];
const UPGRADE_TYPES = ['loan_estimate', 'purchase_contract'];

// Two tiers, because the value is genuinely bimodal. A Closing Disclosure alone
// supports arithmetic verification, duplicate detection and fee questions — a
// competent second pair of eyes, but not a savings-finder. Loan Estimates unlock
// TRID tolerance testing, and the purchase contract unlocks credit
// reconciliation; both can conclude that money is owed back. Charging one price
// for both would overcharge the first customer and undercharge the second.
const TIERS = {
  basic: { id: 'basic', price_cents: 2900, price_label: '$29' },
  full: { id: 'full', price_cents: 5900, price_label: '$59' },
};

function determineTier(documents) {
  const types = (documents || []).map((d) => d.document_type);
  const extras = types.filter((t) => UPGRADE_TYPES.includes(t));
  const tier = extras.length ? TIERS.full : TIERS.basic;
  return {
    ...tier,
    has_loan_estimate: types.includes('loan_estimate'),
    has_purchase_contract: types.includes('purchase_contract'),
    upgrade_documents: extras.length,
  };
}

async function extractClosingDisclosure(apiKey, contentBlocks) {
  return callAnthropic({
    apiKey,
    system: EXTRACTION_SYSTEM,
    tools: [EXTRACTION_TOOL],
    contentBlocks: [
      ...contentBlocks,
      { type: 'text', text: 'Extract everything printed on this document.' },
    ],
  });
}

// ---------------------------------------------------------------------------
// audit orchestration
// ---------------------------------------------------------------------------

// Both forms carry the fee lines the audit is built on. Only the Closing
// Disclosure carries loan terms, the lettered subtotals and the escrow
// disclosure, so an ALTA statement supports a real but narrower audit — and the
// customer is told exactly which checks it cannot support rather than being
// turned away or quietly given less.
const ACCEPTED_DOCUMENT_TYPES = ['closing_disclosure', 'alta_settlement_statement'];

const DOCUMENT_LABELS = {
  closing_disclosure: 'Closing Disclosure',
  alta_settlement_statement: 'ALTA Settlement Statement',
  loan_estimate: 'Loan Estimate',
  purchase_contract: 'purchase contract',
  other: 'document',
};

// Checks that structurally cannot run without the Closing Disclosure itself.
const CD_ONLY_CHECKS = [
  'section subtotals (A-J)',
  'Cash to Close',
  'prepaid interest',
  'escrow cushion',
  'TRID tolerance testing',
];

// The extractor is told not to return section headings and subtotals as charge
// lines, but an instruction is not a guarantee — and on a real document it
// returned seven of them. They must be filtered deterministically too, because
// a subtotal treated as a fee gets benchmarked, duplicate-checked and totalled.
const SUBTOTAL_LABELS = [
  /^total\b/i,
  /^subtotal/i,
  /\bsubtotals?\b/i,
  /^origination charges$/i,
  /^services borrower did (not )?shop for$/i,
  /^taxes and other government fees$/i,
  /^prepaids$/i,
  /^initial escrow payment at closing$/i,
  /^other costs?$/i,
  /^loan costs?$/i,
  /^closing costs?$/i,
  /^total payoffs and payments$/i,
  /\(payoff\)\s*$/i,
];

function isSubtotalLine(li) {
  const label = String(li.label || '').replace(/^[A-K]\.\s*/, '').trim();
  return SUBTOTAL_LABELS.some((re) => re.test(label));
}

const CONF_THRESHOLD = 0.85;
const confident = (o) => o && typeof o.confidence === 'number' && o.confidence >= CONF_THRESHOLD;
const val = (o) => (confident(o) ? o.value : null);

// getBenchmark is injected. Until a benchmark corpus exists it returns null for
// everything, and every benchmarkable fee comes back "cannot benchmark" — which
// is the honest answer, not a gap to paper over.
function runClosingAudit(extraction, options = {}) {
  const {
    answers = {},
    loanEstimates = null,
    contractTerms = null,
    getBenchmark = defaultGetBenchmark,
  } = options;

  const e = extraction || {};
  const findings = [];
  const skipped = [];

  // --- extraction confidence gate, before anything is trusted ---------------
  const fields = (e.line_items || []).map((li, i) => ({
    name: li.label || `line ${i + 1}`,
    page: li.page || 0,
    confidence: typeof li.confidence === 'number' ? li.confidence : 0,
    path: `line_items.${i}`,
    item: li,
  }));
  const { usable, warnings } = audit.gateExtraction(fields, CONF_THRESHOLD);
  findings.push(...warnings);
  const lines = usable.map((f) => f.item).filter((li) => !isSubtotalLine(li));

  if (e.document_type === 'alta_settlement_statement') {
    findings.push(audit.finding({
      checkId: 'DOCUMENT_SCOPE',
      title: 'Audited from an ALTA Settlement Statement',
      severity: audit.Severity.REQUIRES_DOCUMENTATION,
      evidence: audit.EvidenceKind.NONE,
      actionability: audit.Actionability.NEEDS_DOCS,
      basis:
        'This is the settlement agent\'s statement, not the lender\'s Closing Disclosure. It carries ' +
        'the charge lines, payees and prorations, so fee-level checks run normally. It does not carry ' +
        'loan terms, the lettered subtotals or the escrow disclosure, so these could not be tested: ' +
        CD_ONLY_CHECKS.join(', ') + '.',
      whyItMatters:
        'Prepaid interest and the escrow cushion are two of the most commonly miscalculated figures ' +
        'in a closing, and neither can be checked without the Closing Disclosure.',
      recommendedAction:
        'Upload the Closing Disclosure as well — your lender must give it to you at least three ' +
        'business days before closing — and these checks will run against it.',
    }));
  }

  for (const p of e.document_problems || []) {
    findings.push(audit.finding({
      checkId: 'DOCUMENT_PROBLEM',
      title: 'Problem with the uploaded document',
      severity: audit.Severity.REQUIRES_DOCUMENTATION,
      evidence: audit.EvidenceKind.NONE,
      actionability: audit.Actionability.NEEDS_DOCS,
      basis: p,
      recommendedAction: 'Upload a complete, clearly legible copy of the affected page.',
    }));
  }

  // --- internal arithmetic --------------------------------------------------
  const st = e.section_totals || {};
  const totalsUsable = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].every((k) => confident(st[k]));
  if (totalsUsable) {
    const totalsFromCustomer = ['A','B','C','D','E','F','G','H','I','J']
      .some((k) => isCustomer(st[k]));
    const arith = audit.checkSectionArithmetic({
      A: val(st.A), B: val(st.B), C: val(st.C), D: val(st.D),
      E: val(st.E), F: val(st.F), G: val(st.G), H: val(st.H),
      I: val(st.I), J: val(st.J), lenderCredits: val(st.lender_credits) || 0,
    });
    findings.push(...(totalsFromCustomer ? arith.map(audit.markCustomerSourced) : arith));
  } else {
    skipped.push('section subtotals');
  }

  const ctc = e.cash_to_close || {};
  if (confident(ctc.stated_cash_to_close) && confident(ctc.total_closing_costs_j)) {
    const ctcFromCustomer = Object.values(ctc).some(isCustomer);
    const ctcFinding = audit.checkCashToClose({
      totalClosingCostsJ: val(ctc.total_closing_costs_j),
      closingCostsPaidBeforeClosing: val(ctc.closing_costs_paid_before_closing) || 0,
      downPaymentFundsFromBorrower: val(ctc.down_payment_funds_from_borrower) || 0,
      deposit: val(ctc.deposit) || 0,
      fundsForBorrower: val(ctc.funds_for_borrower) || 0,
      sellerCredits: val(ctc.seller_credits) || 0,
      adjustmentsAndOtherCredits: val(ctc.adjustments_and_other_credits) || 0,
      statedCashToClose: val(ctc.stated_cash_to_close),
      totalPayoffsAndPayments: confident(ctc.total_payoffs_and_payments)
        ? val(ctc.total_payoffs_and_payments) : null,
      loanAmount: e.loan_amount,
      transactionType: e.transaction_type,
    });
    findings.push(ctcFromCustomer ? audit.markCustomerSourced(ctcFinding) : ctcFinding);
  } else {
    skipped.push('Cash to Close');
  }

  // --- prepaid interest -----------------------------------------------------
  const pi = e.prepaid_interest;
  if (pi && confident(pi) && e.loan_amount && e.interest_rate_pct && e.closing_date) {
    const piFinding = audit.checkPrepaidInterest({
      loanAmount: e.loan_amount,
      annualRatePct: e.interest_rate_pct,
      closingDate: e.closing_date,
      chargedAmount: pi.amount,
      daysCharged: typeof pi.days === 'number' ? pi.days : null,
    });
    findings.push(isCustomer(pi) ? audit.markCustomerSourced(piFinding) : piFinding);
  } else {
    skipped.push('prepaid interest');
  }

  // --- escrow cushion -------------------------------------------------------
  const esc = e.escrow || {};
  const disb = (esc.annual_disbursements || []).filter((d) => d.confidence >= CONF_THRESHOLD);
  const cushionStated = typeof esc.cushion_amount === 'number'
    && (esc.cushion_confidence === undefined || esc.cushion_confidence >= CONF_THRESHOLD);

  if (disb.length && cushionStated) {
    findings.push(audit.checkEscrowCushion(
      Object.fromEntries(disb.map((d) => [d.item, d.annual_amount])),
      esc.cushion_amount
    ));
  } else if (disb.length && typeof esc.aggregate_adjustment === 'number') {
    // Most Closing Disclosures never state a cushion on its own. The aggregate
    // adjustment is the line that brings the opening deposit down to the
    // permitted balance, so its presence is evidence the cushion calculation was
    // performed — not proof it was performed correctly. Report that honestly
    // rather than testing a number that is not the cushion.
    findings.push(audit.finding({
      checkId: 'ESCROW_CUSHION',
      title: 'Escrow cushion could not be tested directly',
      severity: audit.Severity.INFORMATIONAL,
      evidence: audit.EvidenceKind.NONE,
      actionability: audit.Actionability.NEEDS_DOCS,
      basis: `Section G shows an initial escrow deposit of `
        + `${audit.toDollars(audit.toCents(esc.section_g_total || 0))} with an aggregate adjustment of `
        + `${audit.toDollars(audit.toCents(esc.aggregate_adjustment))}. Section G is the whole opening `
        + `deposit — months of funding plus any cushion — not the cushion itself, so the RESPA 1/6 cap `
        + `cannot be applied to it. The aggregate adjustment is the line that limits the account to the `
        + `permitted balance.`,
      whyItMatters: 'Verifying the cushion requires the initial escrow account statement, which is a '
        + 'separate document from the Closing Disclosure.',
      recommendedAction: 'Ask the lender for the initial escrow account statement if you want this checked.',
    }));
    skipped.push('escrow cushion (needs the initial escrow account statement)');
  } else {
    skipped.push('escrow cushion');
  }

  // --- prorations -----------------------------------------------------------
  for (const p of e.prorations || []) {
    if (p.confidence < CONF_THRESHOLD) continue;
    if (!p.annual_amount || !p.period_start || !p.period_end || !e.closing_date) {
      skipped.push(`${p.label} proration`);
      continue;
    }
    findings.push(audit.checkProration({
      label: p.label,
      annualAmount: p.annual_amount,
      periodStart: p.period_start,
      periodEnd: p.period_end,
      prorationDate: e.closing_date,
      chargedAmount: p.charged_amount,
      payer: p.payer || 'buyer',
    }));
  }

  // --- duplicates and stacking ---------------------------------------------
  findings.push(...audit.detectDuplicates(lines.map((li) => ({
    section: li.section,
    label: li.label,
    amount: li.amount,
    payee: li.payee,
    paidBy: li.paid_by || 'borrower',
  }))));

  // --- benchmarks -----------------------------------------------------------
  // transfer_tax is deliberately absent: it is tested in aggregate below,
  // because a single line is one party's contractual share of the tax.
  const BENCHMARKABLE = new Set([
    'title_insurance_owners', 'title_insurance_lenders', 'recording_fee',
    'appraisal', 'survey', 'attorney', 'settlement_service',
  ]);
  for (const li of lines) {
    if (!BENCHMARKABLE.has(li.category)) continue;
    if (!li.amount) continue;
    const bmFinding = audit.compareToBenchmark(li.label, li.amount, getBenchmark({
      category: li.category,
      state: e.property_state,
      county: e.property_county,
      loanAmount: e.loan_amount,
      salePrice: e.sale_price || null,
    }));
    findings.push(isCustomer(li) ? audit.markCustomerSourced(bmFinding) : bmFinding);
  }

  // --- transfer taxes: tested in aggregate, never line by line ---------------
  //
  // A settlement statement shows each party's SHARE. Buyer and seller commonly
  // split these 50/50 by contract, so comparing one line against the statutory
  // rate would report a correctly-paid half as a shortfall. Allocation is
  // contractual; the tax is not. We test the total and say so.
  //
  // And we only ever flag a total that EXCEEDS the unexempted statutory figure.
  // Maryland alone has first-time-buyer and owner-occupied reductions, so a
  // total coming in low is far more likely to be a correctly applied exemption
  // than an error, and calling it one would be a false accusation.
  if (typeof getBenchmark.stacked === 'function' && e.sale_price) {
    const taxLines = (e.line_items || []).filter(
      (li) => li.category === 'transfer_tax' && typeof li.amount === 'number'
    );
    const stack = getBenchmark.stacked({
      category: 'transfer_tax',
      state: e.property_state,
      county: e.property_county,
      salePrice: e.sale_price,
      loanAmount: e.loan_amount,
    });

    if (taxLines.length && stack.total !== null && e.sale_price <= 1000000) {
      const charged = Math.round(taxLines.reduce((a, li) => a + li.amount, 0) * 100) / 100;
      const variance = Math.round((charged - stack.total) * 100) / 100;
      const breakdown = stack.components
        .map((c) => `${c.label} ${audit.toDollars(audit.toCents(c.amount))}`).join(' + ');
      const notes = stack.components.map((c) => c.note).filter(Boolean).join(' ');

      if (variance > 1) {
        findings.push(audit.finding({
          checkId: 'TRANSFER_TAX_TOTAL',
          title: 'Transfer taxes exceed the statutory amount for this jurisdiction',
          severity: audit.Severity.POTENTIAL_OVERCHARGE,
          evidence: stack.evidence,
          actionability: audit.Actionability.CHANGEABLE_BEFORE_CLOSING,
          dollarImpact: variance,
          charged,
          expected: stack.total,
          variance,
          basis: `${breakdown} = ${audit.toDollars(audit.toCents(stack.total))} on a sale price of `
            + `${audit.toDollars(audit.toCents(e.sale_price))}. Source: ${stack.components[0].source}.`,
          whyItMatters:
            'These are statutory rates, not negotiable service charges. Buyer and seller may split them '
            + 'however the contract says, but the total owed to the state and county is fixed.',
          recommendedAction:
            'Ask the settlement agent to show the transfer tax calculation against the sale price.',
          askSettlement: true,
          detail: { components: stack.components, lines_counted: taxLines.length },
        }));
      } else {
        findings.push(audit.finding({
          checkId: 'TRANSFER_TAX_TOTAL',
          title: variance < -1
            ? 'Transfer taxes are below the standard statutory amount'
            : 'Transfer taxes match the statutory amount',
          severity: variance < -1 ? audit.Severity.INFORMATIONAL : audit.Severity.WITHIN_NORMS,
          evidence: stack.evidence,
          actionability: audit.Actionability.LIKELY_LOCKED,
          charged,
          expected: stack.total,
          variance,
          basis: `${breakdown} = ${audit.toDollars(audit.toCents(stack.total))} before exemptions, on a `
            + `sale price of ${audit.toDollars(audit.toCents(e.sale_price))}. Your statement shows `
            + `${audit.toDollars(audit.toCents(charged))} across ${taxLines.length} line`
            + `${taxLines.length === 1 ? '' : 's'}; the remainder is normally the other party's share, `
            + `which the contract decides. Source: ${stack.components[0].source}.`
            + (variance < -1 && notes ? ' ' + notes : ''),
          whyItMatters: variance < -1
            ? 'A total below the standard rate usually means an exemption was applied, not that '
              + 'something is missing. We do not treat it as an error.'
            : '',
        }));
      }
    }
  }

  // --- TRID tolerances, only if Loan Estimates were supplied ----------------
  let cureNote = null;
  if (loanEstimates && loanEstimates.length && e.closing_date) {
    const { baseline, findings: baselineFindings } =
      audit.selectBaseline(loanEstimates, e.closing_date);
    findings.push(...baselineFindings);

    const cdCharges = {};
    for (const li of lines) {
      cdCharges[chargeKey(li)] = {
        label: li.label,
        amount: li.amount,
        category: li.category || 'other',
        shoppable: Boolean(li.shoppable),
        providerOnLenderList: answers.provider_on_lender_list ?? null,
      };
    }
    findings.push(...audit.analyzeTolerances(
      baseline, cdCharges, normalizeProviderListAnswer(answers.provider_list)
    ));
    cureNote = audit.cureDeadlineNote(e.closing_date);
  }

  // --- purchase contract ----------------------------------------------------
  if (contractTerms && contractTerms.length) {
    const cdCredits = {};
    for (const c of e.seller_credits_on_cd || []) {
      if (c.confidence >= CONF_THRESHOLD) cdCredits[c.label] = c.amount;
    }
    findings.push(...audit.reconcileContract(contractTerms, cdCredits));
  }

  return { findings: audit.rankFindings(findings), skipped, cureNote };
}

const chargeKey = (li) =>
  `${li.category || 'other'}:${String(li.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

// "Don't know" and "no" are not the same as "yes", and only "yes" unlocks the
// 10% bucket for shoppable services. Anything other than an explicit yes is
// treated conservatively.
function normalizeProviderListAnswer(a) {
  if (a === 'yes' || a === true) return true;
  if (a === 'no' || a === false) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Loan Estimate extraction
// ---------------------------------------------------------------------------
//
// This is what the $59 tier is sold on. Without it, runClosingAudit receives
// loanEstimates: null and the tolerance engine — fully built and tested — never
// executes. A customer would be charged double for an analysis that cannot run.

const LE_EXTRACTION_TOOL = {
  name: 'submit_le_extraction',
  description:
    'Report the charges printed on this Loan Estimate. Report only what is on the document; '
    + 'never compute a missing value and never carry a figure over from another document.',
  input_schema: {
    type: 'object',
    properties: {
      is_loan_estimate: { type: 'boolean', description: 'False if this is not actually a Loan Estimate.' },
      date_issued: { type: 'string', description: 'Date issued, YYYY-MM-DD.' },
      date_received: { type: 'string', description: 'Date received by the consumer if printed, YYYY-MM-DD.' },
      is_revised: { type: 'boolean', description: 'True if this appears to be a revised Loan Estimate rather than the initial one.' },
      changed_circumstance_documented: {
        type: 'boolean',
        description: 'True ONLY if the document itself states a changed circumstance justifying a revision. '
          + 'Absence of a statement is false, not unknown — a revision without documentation cannot reset the baseline.',
      },
      loan_amount: { type: 'number' },
      charges: {
        type: 'array',
        description: 'Every individual charge line in sections A through H. Exclude section headings and subtotals.',
        items: {
          type: 'object',
          properties: {
            section: { type: 'string', enum: ['A', 'B', 'C', 'E', 'F', 'G', 'H'] },
            label: { type: 'string', description: 'The fee name exactly as printed.' },
            amount: { type: 'number' },
            category: {
              type: 'string',
              enum: [
                'origination', 'lender_fee', 'credit_report', 'rate_lock_fee', 'appraisal',
                'settlement_service', 'title_insurance_owners', 'title_insurance_lenders',
                'survey', 'attorney', 'recording_fee', 'transfer_tax', 'prepaid_interest',
                'property_insurance', 'property_tax', 'escrow_deposit', 'hoa_dues',
                'optional_product', 'non_required_service', 'affiliate_service',
                'unshoppable_service', 'other',
              ],
              description: 'Classify by what the charge IS, using the same scheme as the Closing '
                + 'Disclosure, so the two documents can be matched line for line.',
            },
            shoppable: { type: 'boolean', description: 'True if the line sits under section C, "Services You Can Shop For".' },
            confidence: { type: 'number', description: CONFIDENCE_DESC },
          },
          required: ['section', 'label', 'amount', 'confidence'],
        },
      },
    },
    required: ['is_loan_estimate', 'charges'],
  },
};

async function extractLoanEstimate(apiKey, contentBlock) {
  return callAnthropic({
    apiKey,
    system: EXTRACTION_SYSTEM,
    tools: [LE_EXTRACTION_TOOL],
    contentBlocks: [contentBlock, { type: 'text', text: 'Extract the charges printed on this Loan Estimate.' }],
  });
}

// Converts an extracted Loan Estimate into the shape selectBaseline and
// analyzeTolerances expect. Keys are built with the same chargeKey() the
// Closing Disclosure side uses, so the two match.
function toLoanEstimateRecord(raw, docId) {
  const charges = {};
  for (const c of raw.charges || []) {
    if (typeof c.confidence === 'number' && c.confidence < CONF_THRESHOLD) continue;
    charges[chargeKey(c)] = {
      label: c.label,
      amount: c.amount,
      category: c.category || 'other',
      shoppable: Boolean(c.shoppable) || c.section === 'C',
    };
  }
  return {
    docId,
    dateIssued: raw.date_issued || null,
    dateReceived: raw.date_received || raw.date_issued || null,
    // Only an explicit statement counts. Treating "not mentioned" as documented
    // would let any revision reset the tolerance baseline.
    changedCircumstanceDocumented: raw.changed_circumstance_documented === true,
    charges,
  };
}

// ---------------------------------------------------------------------------
// customer-supplied corrections
// ---------------------------------------------------------------------------

// Fields a customer can meaningfully read off their own document. Deliberately
// narrow: figures printed on the page they are holding, nothing that requires
// research. Asking someone to look up their county's transfer tax rate would be
// asking them to do the job they paid us for; asking them to read a number off
// page 3 is not.
const CORRECTABLE_TOTALS = {
  A: 'Section A total (Origination Charges)',
  B: 'Section B total (Services Borrower Did Not Shop For)',
  C: 'Section C total (Services Borrower Did Shop For)',
  D: 'Section D — Total Loan Costs',
  E: 'Section E total (Taxes and Other Government Fees)',
  F: 'Section F total (Prepaids)',
  G: 'Section G total (Initial Escrow Payment at Closing)',
  H: 'Section H total (Other)',
  I: 'Section I — Total Other Costs',
  J: 'Section J — Total Closing Costs',
};

const CORRECTABLE_CTC = {
  total_closing_costs_j: 'Total Closing Costs (J) on the Cash to Close table',
  down_payment_funds_from_borrower: 'Down payment / funds from borrower',
  deposit: 'Deposit',
  seller_credits: 'Seller credits',
  adjustments_and_other_credits: 'Adjustments and other credits',
  stated_cash_to_close: 'Cash to Close',
};

// Returns the list of values we could not read confidently, each with a stable
// path, a human label, and the page to look at. This is what the UI renders.
function listUnreadableFields(extraction) {
  const e = extraction || {};
  const out = [];
  const lowConf = (o) => o && typeof o.confidence === 'number' && o.confidence < CONF_THRESHOLD;

  (e.line_items || []).forEach((li, i) => {
    if (lowConf(li)) {
      out.push({
        path: `line_items.${i}`,
        label: li.label || `Charge on line ${i + 1}`,
        page: li.page || null,
        kind: 'amount',
        read_confidence: li.confidence,
      });
    }
  });

  const st = e.section_totals || {};
  for (const [key, label] of Object.entries(CORRECTABLE_TOTALS)) {
    if (st[key] && lowConf(st[key])) {
      out.push({
        path: `section_totals.${key}`, label, page: st[key].page || 2,
        kind: 'amount', read_confidence: st[key].confidence,
      });
    }
  }

  const ctc = e.cash_to_close || {};
  for (const [key, label] of Object.entries(CORRECTABLE_CTC)) {
    if (ctc[key] && lowConf(ctc[key])) {
      out.push({
        path: `cash_to_close.${key}`, label, page: ctc[key].page || 3,
        kind: 'amount', read_confidence: ctc[key].confidence,
      });
    }
  }

  if (e.prepaid_interest && lowConf(e.prepaid_interest)) {
    out.push({
      path: 'prepaid_interest.amount', label: 'Prepaid interest amount (Section F)',
      page: e.prepaid_interest.page || 2, kind: 'amount',
      read_confidence: e.prepaid_interest.confidence,
    });
  }

  return out;
}

// Applies customer-entered values, tagging each with value_source: 'customer'.
// Confidence is set to 1 so the check will RUN, but the tag is what travels into
// the finding — a typed number must never look like a verified reading.
function mergeCustomerValues(extraction, values) {
  const e = JSON.parse(JSON.stringify(extraction || {}));
  const applied = [];
  const rejected = [];
  const allowed = new Set(listUnreadableFields(extraction).map((f) => f.path));

  for (const [path, raw] of Object.entries(values || {})) {
    // Only fields we actually flagged as unreadable can be overwritten. Without
    // this, a caller could rewrite any figure on the document.
    if (!allowed.has(path)) { rejected.push({ path, reason: 'not_flagged_as_unreadable' }); continue; }

    const num = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(num)) { rejected.push({ path, reason: 'not_a_number' }); continue; }

    const parts = path.split('.');
    let target = null;
    if (parts[0] === 'line_items') target = e.line_items[Number(parts[1])];
    else if (parts[0] === 'section_totals') target = e.section_totals[parts[1]];
    else if (parts[0] === 'cash_to_close') target = e.cash_to_close[parts[1]];
    else if (parts[0] === 'prepaid_interest') target = e.prepaid_interest;
    if (!target) { rejected.push({ path, reason: 'not_found' }); continue; }

    if (parts[0] === 'line_items' || parts[0] === 'prepaid_interest') target.amount = num;
    else target.value = num;

    target.confidence = 1;
    target.value_source = 'customer';
    applied.push({ path, value: num });
  }

  return { extraction: e, applied, rejected };
}

const isCustomer = (o) => Boolean(o && o.value_source === 'customer');

// ---------------------------------------------------------------------------
// free scorecard
// ---------------------------------------------------------------------------

const FLAG_SEVERITIES = new Set([
  audit.Severity.CONFIRMED_MATH_ERROR,
  audit.Severity.POTENTIAL_TRID_VIOLATION,
  audit.Severity.POTENTIAL_OVERCHARGE,
  audit.Severity.POTENTIAL_DUPLICATE,
  audit.Severity.ABOVE_BENCHMARK,
]);

// Deliberately does NOT include CANNOT_BENCHMARK. "We have no rate data for
// your county" is our gap, not a missing document, and telling a customer they
// need to supply 23 more documents when no document would help is a lie by
// category error.
const NEEDS_DOCS_SEVERITIES = new Set([
  audit.Severity.REQUIRES_DOCUMENTATION,
]);

// Deliberately counts and headline figures only — enough to show the audit
// found something real, not enough to substitute for the paid report. It never
// names a flagged fee or its dollar impact.
function buildScorecard(extraction, findings, skipped = []) {
  const e = extraction || {};
  const st = e.section_totals || {};
  // J appears in two places. On a partial upload (a page-3 excerpt, or a scan
  // missing page 2) the section subtotal is absent but the Cash to Close table
  // still carries it. Fall back rather than showing the customer a blank where
  // the headline number should be.
  const ctcJ = (e.cash_to_close || {}).total_closing_costs_j;
  const totalClosingCosts = confident(st.J) ? val(st.J)
    : (confident(ctcJ) ? val(ctcJ) : null);
  const loanAmount = typeof e.loan_amount === 'number' ? e.loan_amount : null;

  const flags = findings.filter((f) => FLAG_SEVERITIES.has(f.severity));
  const needsDocs = findings.filter((f) => NEEDS_DOCS_SEVERITIES.has(f.severity));
  const cannotBenchmark = findings.filter((f) => f.severity === audit.Severity.CANNOT_BENCHMARK);

  // A settlement statement prints no "Total Closing Costs (J)". Rather than
  // showing a blank where the headline number should be, total the borrower-paid
  // charge lines — and label it as calculated, because it is not the same figure
  // as J and must not be passed off as one.
  //
  // Deposits and holdbacks are excluded. The first real document through this
  // system was a rehab loan carrying a $24,000 construction escrow; counting it
  // as a "charge" produced a headline of $31,948 at 33.3% of the loan, when the
  // borrower's actual fees were $7,948 at 8.3%. That money is the borrower's own,
  // held for the renovation — it is not a cost, and presenting it as one would
  // alarm a customer over nothing and destroy trust in every other number.
  const NOT_A_CHARGE = new Set(['escrow_deposit', 'property_insurance', 'hoa_dues']);

  const allBorrowerLines = (e.line_items || []).filter(
    (li) => li.category && (li.paid_by || 'borrower') === 'borrower'
      && typeof li.amount === 'number' && !isSubtotalLine(li)
  );
  const chargeLines = allBorrowerLines.filter((li) => !NOT_A_CHARGE.has(li.category));
  const depositLines = allBorrowerLines.filter((li) => NOT_A_CHARGE.has(li.category));

  const derivedTotal = chargeLines.reduce((a, li) => a + li.amount, 0);
  const depositTotal = depositLines.reduce((a, li) => a + li.amount, 0);
  const extractionWarnings = findings.filter((f) => f.checkId === 'EXTRACTION_CONFIDENCE');

  const isAlta = e.document_type === 'alta_settlement_statement';

  return {
    document_type: e.document_type || 'other',
    document_label: DOCUMENT_LABELS[e.document_type] || 'document',
    is_closing_disclosure: e.document_type === 'closing_disclosure',
    checks_unavailable: isAlta ? CD_ONLY_CHECKS : [],
    property_state: e.property_state || null,
    property_county: e.property_county || null,
    total_closing_costs: totalClosingCosts,
    loan_amount: loanAmount,
    closing_costs_pct_of_loan:
      totalClosingCosts !== null && loanAmount
        ? Math.round((totalClosingCosts / loanAmount) * 1000) / 10
        : null,
    flag_count: flags.length,
    needs_more_documents_count: needsDocs.length,
    cannot_benchmark_count: cannotBenchmark.length,
    total_is_derived: totalClosingCosts === null && chargeLines.length > 0,
    total_borrower_charges: chargeLines.length ? Math.round(derivedTotal * 100) / 100 : null,
    charge_lines_counted: chargeLines.length,
    deposits_excluded: depositLines.length
      ? { total: Math.round(depositTotal * 100) / 100, count: depositLines.length }
      : null,
    extraction_warning_count: extractionWarnings.length,
    checks_skipped: skipped,
    unreadable_fields: listUnreadableFields(e),
    customer_supplied_count: [
      ...(e.line_items || []),
      ...Object.values(e.section_totals || {}),
      ...Object.values(e.cash_to_close || {}),
      e.prepaid_interest,
    ].filter(isCustomer).length,
    line_items_read: (e.line_items || []).length,
    pages_read: e.pages_present || null,
  };
}

module.exports = {
  ANTHROPIC_MODEL,
  LE_EXTRACTION_TOOL,
  extractLoanEstimate,
  toLoanEstimateRecord,
  isSubtotalLine,
  classifyDocuments,
  determineTier,
  TIERS,
  PRIMARY_TYPES,
  listUnreadableFields,
  mergeCustomerValues,
  ACCEPTED_DOCUMENT_TYPES,
  DOCUMENT_LABELS,
  CD_ONLY_CHECKS,
  EXTRACTION_TOOL,
  EXTRACTION_SYSTEM,
  extractClosingDisclosure,
  runClosingAudit,
  buildScorecard,
  normalizeProviderListAnswer,
  chargeKey,
  CONF_THRESHOLD,
};
