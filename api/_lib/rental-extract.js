'use strict';

// Reads a landlord's documents into structured numbers. It does not judge them.
//
// This is the first half of the arrangement api/_lib/rental-audit.js describes:
// the model's job here is transcription, and every conclusion is drawn
// afterwards by arithmetic that runs the same way every time. Splitting the two
// is the whole point. A model asked to read AND judge in one pass will notice
// what stands out and stay quiet about what does not, which is exactly how an
// active mortgage insurance charge at 66% loan-to-value left a paid report
// without a mention on 2026-09-09.
//
// So the rules for this call are narrow: copy figures, classify them into a
// fixed vocabulary, and leave anything you cannot find as null. A null costs
// the customer one skipped check, named in their report. A guess costs them a
// finding built on a number nobody wrote down.

const EXTRACT_MODEL = 'claude-sonnet-5';

const EXPENSE_CATEGORIES = [
  'management', 'leasing_turnover', 'repairs_maintenance', 'water_sewer', 'trash',
  'electric', 'gas', 'landscaping', 'snow', 'warranty', 'insurance', 'taxes',
  'pest', 'admin', 'hoa', 'other',
];

const SYSTEMS = ['hvac', 'plumbing', 'roof', 'appliance', 'electrical', 'exterior', 'landscaping', 'other'];

const EXTRACT_TOOL = {
  name: 'record_rental_documents',
  description: 'Record every figure found in the landlord\'s documents, without interpreting them.',
  input_schema: {
    type: 'object',
    properties: {
      property: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          unit_count: { type: 'number', description: 'Number of rentable units. A single-family rental is 1.' },
          year_built: { type: 'number' },
          purchase_price: { type: 'number' },
          purchase_date: { type: 'string' },
          property_type: { type: 'string' },
        },
      },
      units: {
        type: 'array',
        description: 'One entry per unit on the rent roll. For a single-family rental, one entry.',
        items: {
          type: 'object',
          properties: {
            unit_id: { type: 'string' },
            bedrooms: { type: 'number' },
            bathrooms: { type: 'number' },
            sqft: { type: 'number' },
            monthly_rent: { type: 'number' },
            lease_start: { type: 'string' },
            lease_end: { type: 'string' },
            status: { type: 'string' },
            notes: { type: 'string', description: 'Anything the rent roll says about condition or renovation, copied not summarised.' },
          },
          required: ['unit_id'],
        },
      },
      income: {
        type: 'object',
        properties: {
          period_start: { type: 'string' },
          period_end: { type: 'string' },
          gross_scheduled_rent: { type: 'number' },
          vacancy_loss: { type: 'number', description: 'Positive number for the amount lost.' },
          collected_rent: { type: 'number' },
          other_income: { type: 'number' },
          total_collected: { type: 'number' },
          net_operating_income: { type: 'number', description: 'Only if the statement states it. Do not compute it.' },
        },
      },
      expenses: {
        type: 'array',
        description: 'One entry per operating expense line. Do NOT include subtotal or total rows — only the '
          + 'individual lines that make them up. If a statement shows components and then a subtotal of those '
          + 'same components, record the components and skip the subtotal.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'The line as printed.' },
            category: { type: 'string', enum: EXPENSE_CATEGORIES },
            annual_amount: { type: 'number' },
            notes: { type: 'string' },
          },
          required: ['label', 'category', 'annual_amount'],
        },
      },
      expense_total_stated: {
        type: 'number',
        description: 'The total operating expenses figure the statement itself prints. Null if it prints none.',
      },
      expense_lines_printed: {
        type: 'number',
        description: 'Count the individual expense lines printed in the statement\'s operating expense section — '
          + 'excluding subtotal and total rows — and record how many there are. Count them off the page before you '
          + 'record them, not afterwards. This is checked against the number you recorded, and a mismatch tells the '
          + 'audit your list is short so it can decline to draw a conclusion from it.',
      },
      maintenance_items: {
        type: 'array',
        description: 'Every itemised repair line, one entry each.',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string' },
            unit_id: { type: 'string', description: 'The unit, if the line names one. Omit for building-wide work.' },
            description: { type: 'string' },
            amount: { type: 'number' },
            system: { type: 'string', enum: SYSTEMS, description: 'Classify from the description. Use "other" only when nothing fits.' },
          },
          required: ['description', 'amount'],
        },
      },
      maintenance_total_stated: {
        type: 'number',
        description: 'The repairs total the statement prints. Record it even when it appears to disagree with the '
          + 'items — especially then. Do not reconcile them and do not adjust either figure.',
      },
      maintenance_lines_printed: {
        type: 'number',
        description: 'How many individual repair lines are printed on the repair schedule. Counted off the page, '
          + 'the same way as expense_lines_printed and for the same reason.',
      },
      utility_months: {
        type: 'array',
        description: 'Month-by-month utility figures where the documents give them.',
        items: {
          type: 'object',
          properties: {
            utility: { type: 'string' },
            month: { type: 'string' },
            amount: { type: 'number' },
          },
          required: ['utility', 'month', 'amount'],
        },
      },
      utilities_owner_paid: {
        type: 'array',
        description: 'Utilities the owner pays rather than the tenant.',
        items: {
          type: 'object',
          properties: {
            utility: { type: 'string' },
            annual_amount: { type: 'number' },
            submetered: { type: 'boolean', description: 'True only if the documents say the units are sub-metered or individually metered for it.' },
          },
          required: ['utility'],
        },
      },
      loan: {
        type: 'object',
        properties: {
          original_amount: { type: 'number' },
          original_property_value: { type: 'number', description: 'Only if a document states the value at origination. Do not substitute the purchase price here.' },
          current_balance: { type: 'number' },
          interest_rate: { type: 'number', description: 'As a percentage, e.g. 4.75.' },
          origination_date: { type: 'string' },
          principal_and_interest_monthly: { type: 'number' },
          mortgage_insurance_monthly: { type: 'number', description: 'PMI or MIP. Record 0 when the statement shows a payment breakdown with no such line, and null when there is no breakdown to read.' },
          escrow_monthly: { type: 'number' },
          escrow_taxes_annual: { type: 'number' },
          escrow_insurance_annual: { type: 'number' },
        },
      },
      debt_service: {
        type: 'object',
        properties: {
          principal_interest_annual: { type: 'number' },
          mortgage_insurance_annual: { type: 'number' },
          total_annual: { type: 'number' },
        },
      },
      insurance: {
        type: 'object',
        properties: {
          annual_premium: { type: 'number' },
          prior_premium: { type: 'number', description: 'Only if the declarations page states the prior term premium.' },
          dwelling_limit: { type: 'number' },
          liability_limit: { type: 'number' },
          deductible_all_perils: { type: 'number' },
          deductible_wind_hail: { type: 'number' },
          policy_period_end: { type: 'string' },
          discounts_applied: { type: 'boolean', description: 'False only if the page explicitly says none were applied.' },
        },
      },
      management: {
        type: 'object',
        properties: {
          self_managed: { type: 'boolean' },
          company_name: { type: 'string' },
          fee_percent: { type: 'number', description: 'As a decimal, e.g. 0.10 for 10%.' },
          fee_basis: { type: 'string', enum: ['gross', 'collected', 'unknown'], description: 'What the percentage is taken on, as the statement describes it.' },
          fee_annual: { type: 'number' },
          turnover_fees_annual: { type: 'number', description: 'Leasing, turnover, administration and make-ready fees charged in addition to the percentage, totalled.' },
        },
      },
      taxes: {
        type: 'object',
        properties: {
          annual_amount: { type: 'number' },
          assessed_value: { type: 'number' },
        },
      },
      documents_seen: {
        type: 'array',
        description: 'What each attachment turned out to be, in order.',
        items: { type: 'string' },
      },
      unreadable: {
        type: 'array',
        description: 'Anything you could see was present but could not read reliably — a cut-off column, a '
          + 'blurred figure, a page that did not scan. Name it rather than filling it in.',
        items: { type: 'string' },
      },
    },
    required: ['documents_seen'],
  },
};

const EXTRACT_SYSTEM = `You are reading a landlord's rental property documents — a rent roll, an owner or operating statement, a mortgage statement, an insurance declarations page, or some subset of those — and recording what they say.

You are not analysing anything. You are not looking for problems. Every judgement about these numbers is made later by a separate deterministic engine, and it can only work with figures that were actually printed on the page.

Rules, in order of importance:

1. NEVER invent, infer or compute a figure. If the statement does not print a total, leave the total null. If a rent is not stated, leave it null. A null means one check is skipped and the customer is told so by name, which is a good outcome. A guessed number silently corrupts a finding they will act on.

2. RECORD DISAGREEMENTS AS YOU FIND THEM. If a schedule of line items does not add up to the total printed beside it, record both, exactly as printed. Do not reconcile them, do not correct either one, and do not leave one out. Discrepancies between a document and itself are the single most valuable thing in these files, and your job is to preserve them intact, not to tidy them.

3. THE EXPENSE LIST MUST BE COMPLETE, AND IT IS THE ONE PLACE A MISTAKE IS EXPENSIVE. "expenses" is every individual operating expense line printed in the statement's expense section. That includes the management fee. That includes the repairs and maintenance line. It includes them EVEN THOUGH you are also recording the management fee in the management object and the individual repairs in maintenance_items — those are additional views of the same figures, not replacements for the expense line, and a figure appearing twice in this form is correct and expected.

Leaving a line out because you captured it elsewhere does not produce a smaller list. It produces a report telling a landlord that their statement is missing thousands of dollars it is not missing, and sending them to their property manager to demand an explanation for a hole you created. Two live reports on 2026-09-09 led with exactly that: one accused a statement of a $5,480 gap that was the management fee, and one of a $2,415 gap that was the repairs line.

The only rows to leave out are subtotals and totals. Where a statement lists several components and then a subtotal of those same components, record the components and omit the subtotal.

3a. Then count. Count the expense lines printed on the page and put that number in expense_lines_printed, and do the same for the repair schedule in maintenance_lines_printed. If your count and your list disagree, the audit declines to judge the totals rather than reporting a discrepancy it cannot stand behind — which is the outcome we want over a confident wrong answer.

3b. Where an operating statement carries its own debt service section, record it: principal and interest, mortgage insurance, and the total, in debt_service.

4. Classify into the enums given. Where a repair description names a system — a furnace, a condenser, a drain, a roof — classify it. Where nothing fits, use "other".

5. Copy dates and unit identifiers exactly as printed, in the document's own format.

6. Anything you can see but cannot read reliably goes in "unreadable", named specifically.

Respond ONLY by calling the record_rental_documents tool.`;

// Two attempts, because a truncated or missing tool call is worth one retry
// before a paying customer's report falls back to a thinner analysis.
async function extractRentalDocuments(apiKey, contentBlocks, options) {
  const opts = options || {};
  const fetchImpl = opts.fetch || fetch;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        max_tokens: 8000,
        system: EXTRACT_SYSTEM,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'tool', name: 'record_rental_documents' },
        messages: [{ role: 'user', content: contentBlocks }],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 500)}`);
    }

    const data = await response.json();
    // A truncated tool call still parses into a plausible-looking object with
    // its later fields missing. Storing that would silently skip whichever
    // checks depend on whatever got cut off.
    if (data.stop_reason === 'max_tokens') {
      lastError = new Error('Document extraction was truncated');
      continue;
    }
    const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'record_rental_documents');
    if (!toolUse) {
      lastError = new Error('Extraction returned no structured result');
      continue;
    }
    return toolUse.input;
  }

  throw lastError || new Error('Document extraction failed');
}

module.exports = {
  extractRentalDocuments,
  EXTRACT_TOOL,
  EXTRACT_SYSTEM,
  EXTRACT_MODEL,
  EXPENSE_CATEGORIES,
  SYSTEMS,
};
