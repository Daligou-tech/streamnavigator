# Iteration 2 — value from uploaded documents only

Goal: sellable findings from the CD (plus an LE or contract when supplied), with
no benchmark corpus, no rate tables, no market data.

## Where you already are

Twenty check IDs exist. Only **two** need the corpus:

| Needs | Checks |
|---|---|
| CD alone | `ARITH_CASH_TO_CLOSE`, `PREPAID_INTEREST`, `PRORATION`, `ESCROW_CUSHION`, `DUPLICATE_CANDIDATE`, `LENDER_FEE_STACKING`, `EXTRACTION_CONFIDENCE`, `DOCUMENT_PROBLEM`, `DOCUMENT_SCOPE` |
| CD + your two questions | `PROPERTY_TYPE_HOA_MISMATCH`, `PROPERTY_TYPE_NO_HOA` |
| CD + LE | all six `TRID_*` |
| CD + contract | `CONTRACT_RECON` |
| **corpus** | `BENCHMARK`, `TRANSFER_TAX_TOTAL` |

So the pivot costs you almost nothing structurally. Set `getBenchmark` to the
null implementation and eighteen checks keep running. What it costs you is the
**$29 tier's stated differentiator** — your own note says benchmarking is what
$29 buys. Drop it and CD-only becomes arithmetic plus duplicate detection, which
is real but thin for $29.

This iteration replaces that spine.

## What's new: `api/_lib/closing-math.js`

Page 5 of every Closing Disclosure carries five federally-required computed
figures — Total of Payments, Finance Charge, Amount Financed, APR, and Total
Interest Percentage. **Your extraction currently reads none of them.** They are
checkable against page 1 and against each other with nothing but arithmetic.

Nine checks, all document-intrinsic:

| Check | Kind | Catches |
|---|---|---|
| `LOAN_MATH_PI` | two-sided, gated | payment that doesn't amortise the stated terms |
| `LOAN_MATH_APR_FLOOR` | **one-sided** | APR below the note rate |
| `LOAN_MATH_APR` | two-sided, gated | APR outside Reg Z's 0.125pp tolerance |
| `LOAN_MATH_FINANCE_CHARGE` | **one-sided** | finance charge below interest alone |
| `LOAN_MATH_TOTAL_OF_PAYMENTS` | **one-sided** | total below the payment schedule |
| `LOAN_MATH_AMOUNT_FINANCED` | **one-sided** | amount financed above the loan amount |
| `LOAN_MATH_TIP` | two-sided, gated | TIP inconsistent with the schedule |
| `LOAN_MATH_POINTS` | exact identity | "1% of loan amount" charged as something else |
| `LOAN_MATH_ESCROW_MONTHLY` | two-sided | monthly escrow ≠ disclosed annual ÷ 12 |

`node test/closing-math.test.js` → **28/28 passed**.

### The design idea worth keeping

**One-sided bounds.** A two-sided check ("this should equal X") fires whenever
our model of the loan is incomplete — an interest-only period, a step rate, MI
dropping off, a temporary buydown. A one-sided check ("this cannot be *less*
than X") fires only when the document states something arithmetically
impossible, and that impossibility doesn't depend on our model being complete.

The finance charge cannot be less than interest alone, because every other
component only adds. The amount financed cannot exceed the loan amount, because
it is the loan amount minus something. Those hold for *every* loan type, so they
need no gate and cannot produce a false accusation.

That is what makes these safe to sell with no benchmark behind them. Every
two-sided check is gated on fixed-rate, fully-amortising, level-payment, and
**declines with a stated reason** rather than guessing — there's a test asserting
all five two-sided checks skip on an ARM instead of firing.

## Wiring — three edits

### 1. Extraction schema (`api/_lib/closing-extract.js`, inside the CD `input_schema.properties`)

```js
monthly_principal_interest: amountField(
  'The monthly Principal & Interest figure from the Projected Payments table on '
  + 'page 1, for the first payment period only.'),

loan_terms_features: {
  type: 'object',
  description:
    'The Loan Terms box on page 1. Each answers "Can this amount increase after '
    + 'closing?" or "Does the loan have these features?". Report false only when the '
    + 'document says NO; omit the field if the box is unreadable.',
  properties: {
    rate_can_increase:        { type: 'boolean' },
    payment_can_increase:     { type: 'boolean' },
    loan_amount_can_increase: { type: 'boolean' },
    has_balloon_payment:      { type: 'boolean' },
    has_prepayment_penalty:   { type: 'boolean' },
    has_interest_only_period: { type: 'boolean' },
  },
},

loan_calculations: {
  type: 'object',
  description:
    'The five figures in the Loan Calculations box on page 5. Transcribe them '
    + 'exactly as printed. Never compute one that is missing — an absent figure is '
    + 'itself a finding.',
  properties: {
    total_of_payments:             amountField('Total of Payments.'),
    finance_charge:                amountField('Finance Charge.'),
    amount_financed:               amountField('Amount Financed.'),
    annual_percentage_rate_pct:    { type: 'number', description: 'APR as printed, e.g. 6.665.' },
    total_interest_percentage_pct: { type: 'number', description: 'TIP as printed, e.g. 71.2.' },
  },
},

points_lines: {
  type: 'array',
  description:
    'Any Section A line whose label states a percentage of the loan amount, such as '
    + '"0.75% of Loan Amount (Points)". One entry per line.',
  items: {
    type: 'object',
    properties: {
      points_pct:     { type: 'number' },
      charged_amount: { type: 'number' },
    },
  },
},
```

Add to the existing `escrow` object:

```js
monthly_escrow_payment:        amountField('Monthly escrow from Projected Payments, page 1.'),
escrowed_property_costs_year1: amountField('Escrowed Property Costs over Year 1, page 4.'),
```

### 2. Hook into `runClosingAudit` (after the prepaid-interest block)

```js
const loanMath = require('./closing-math');

const lc = e.loan_calculations || {};
const lm = loanMath.runLoanMath({
  loanAmount:   e.loan_amount,
  annualRatePct: e.interest_rate_pct,
  termMonths:   e.loan_term_years ? e.loan_term_years * 12 : null,
  statedPI:     val(e.monthly_principal_interest),
  amountFinanced:  val(lc.amount_financed),
  financeCharge:   val(lc.finance_charge),
  totalOfPayments: val(lc.total_of_payments),
  statedApr:       lc.annual_percentage_rate_pct,
  statedTipPct:    lc.total_interest_percentage_pct,
  monthlyEscrow:              val((e.escrow || {}).monthly_escrow_payment),
  escrowedPropertyCostsYear1: val((e.escrow || {}).escrowed_property_costs_year1),
  pointsLines: (e.points_lines || []).map((p) => ({
    pointsPct: p.points_pct, chargedAmount: p.charged_amount,
  })),
  terms: e.loan_terms_features || {},
});
findings.push(...lm.findings);
skipped.push(...lm.skipped);
```

`val()` and `confident()` already exist in that file. The checks return
`{skipped}` rather than a finding when an input is missing, so partial
extraction degrades cleanly.

### 3. Turn benchmarking off cleanly

Don't delete it. Pass the null implementation:

```js
runClosingAudit(extraction, { getBenchmark: () => null });
```

`compareToBenchmark` already returns `CANNOT_BENCHMARK` on null, and
`buildScorecard` deliberately excludes `CANNOT_BENCHMARK` from "items needing
another document". So the corpus can come back later without a rewrite.

**Still commit the `stacked()` completeness fix from Iteration 1.** With a thin
corpus it matters more, not less: it was returning a state-tax-only total for
unmodelled counties and reporting correct charges as overcharges.

## Where I'd disagree with you

Dropping benchmarks is right for now — a half-filled corpus that says "10 of 14
fees, no rate data" actively damages the pitch, and you can't buy your way to
national coverage quickly. But **"is this fee too high?" is the question
customers actually arrive with**, and nothing in this iteration answers it.

What this iteration does is give you a different question that's worth money and
that you can answer completely today: *"is this document correct?"* That is a
better $29 product than a partial benchmark, because completeness is achievable.
A finding like "your disclosed finance charge is $4,200 less than the interest
your own payment schedule produces" needs no market data, cites only the
customer's own document, and is not arguable.

The upgrade path also gets cleaner. $59 becomes *"and here's whether the
increases were permitted"* — TRID tolerance testing against the LE, which is
already built and is the strongest thing you own. Two documents, hard rules,
refundable dollars.

## Ranked next, all document-intrinsic

1. **Tolerance-cure signal from the CD alone.** A lender credit labelled as a
   cure, or a "Lender Credits" line that appears on the CD, is the lender's own
   admission that a zero-tolerance or 10% basket was breached. Readable without
   the LE. Tells the customer to demand the LE and check the cure was complete.
2. **Section placement.** A zero-tolerance charge sitting in Section C, or a
   lender-required service listed as shoppable with the lender's own affiliate
   as payee, changes which tolerance bucket applies. Structural, no benchmark.
3. **Date logic.** Closing date vs disbursement date vs first payment date vs
   the per-diem days already extracted. Cheap, and inconsistencies are common.
4. **Seller-paid / borrower-paid column integrity.** The paid-by columns must
   reconcile to the Summaries of Transactions on page 3. Pure arithmetic.
5. **"Did they give you the CD three business days before closing?"** One
   question, one date already extracted, and a real §1026.19(f) answer.

## Files and destinations

| File | Path in `Daligou-tech/streamnavigator` |
|---|---|
| `closing-math.js` | `api/_lib/closing-math.js` *(new)* |
| `closing-math.test.js` | `test/closing-math.test.js` *(new)* |
| this file | `docs/07-document-intrinsic-checks.md` |
