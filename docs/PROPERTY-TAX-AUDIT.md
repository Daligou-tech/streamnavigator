# STREAM NAVIGATOR — PROPERTY TAX ENGINE AUDIT REPORT

An evaluation of `/property-tax` — the page, the intake, the decision engine
behind it, and whether a customer who pays gets more back than they paid.

Conducted 2026-09-20 against `property-tax.html`, `navigator-property-tax-
engine.js`, `api/_lib/navigator-engine.js`, `api/navigator-intake.js`,
`prices.config.json` and `tests/` — both on the live site
(`https://streamnavigator.ai/property-tax`) and in the repository at `main`.
No paid model runs were spent verifying report generation itself: the
Anthropic account has been out of credit since 2026-09-13 and every attempt
since has returned `400: "Your credit balance is too low"` ([[no-api-credit-topups]]).
Everything downstream of the model call — extraction quality, how well the
write-up honors its own rules — is **Unable to verify** and is labelled that
way below rather than assumed working.

This audit landed in the middle of the fix. `navigator-property-tax-engine.js`
and its server-side wiring shipped in commit `3625e74` before this session
started; the page itself (`property-tax.html`) was still the old free-text
version when this audit began, and confirming that live produced this
report's first and most important finding.

---

## Executive Summary

**Between the two halves of today's fix landing, `/property-tax` was
completely unsellable — every checkout attempt failed.** Commit `3625e74`
shipped a server-side sufficiency gate that requires a current assessed
value, a physical-change answer and a factual-error answer. It shipped alone;
`property-tax.html` still POSTed `{ category, description }` from a single
free-text box. Verified live at the start of this audit: filling out the
real page and clicking "Get My Report →" returned `400` from
`/api/navigator-intake` with the message *"Enter your current assessed
value"* — a field that did not exist anywhere on the page a customer could
see. **Every submission attempted between those two deploys was rejected.**
No customer could have completed a purchase.

**That gap closed during this audit**, in commit `636136b`, which rebuilt
`property-tax.html` with the structured fields the engine requires, gated
client-side by the same `PropertyTaxEngine.checkSufficiency()` the server
enforces, and restyled the page to `/closing`'s typography and palette. This
audit verified the fix live: filling in an address, both assessed values, both
yes/no answers and an email now reaches Stripe checkout successfully (stopped
before any real charge, per this audit's payment-safety rules). 85 test
suites pass, including 13 new engine tests and 169 lines of new intake-gate
tests.

**What works now:** the page is honest. The widest promise-vs-delivery gap
this audit line has found anywhere — "AI pulls comparable properties" sold
against a prompt that, in its own words, held no MLS or assessor database —
is gone. The product now does exactly what it claims: arithmetic on the
homeowner's own current and prior assessed value, their own tax rate, and
comparable properties they supply, never one the engine invents. A factual
error on the notice — the single most winnable appeal ground there is —
always leads, regardless of the dollar math. The design now matches
`/closing`'s paper-and-ink system rather than the shared violet/mint
gradient.

**What remains weak:** the report can ship with zero dollar figures, because
the one field that produces a dollar amount — the customer's own tax rate —
is optional, while the page's headline promise is "the dollar impact of any
change." A "worth appealing" verdict is not scaled to size: a 6% change at a
low tax rate and a 40% change at a high one both read as "the strongest case
in this report for an appeal," with no minimum-savings judgment call. And any
reported physical change — however small — unconditionally reclassifies an
increase as "likely justified," with no check on whether the increase is
proportionate to the change. None of these are found-and-shipped defects the
way the checkout gap was; they are gaps in an otherwise sound, honest engine.

**Price:** current $99, one-time. **Recommended: $79, one-time** — see
Pricing, below. This is not the unfixed product's price; it is what this
product, now honest about doing arithmetic on the customer's own figures
rather than pulling comparables, is worth next to the two products ($79
each) that do more work than it does (Insurance and HOA both extract and
diff real uploaded documents; this engine's most labor-intensive check is
averaging up to two numbers the customer typed in) and next to the one
product ($59, Home Maintenance) that shares its exact shape — no document
required, the customer supplies the figures, a deterministic engine
categorizes them, the model writes it up.

---

## Promise vs. Delivery

| Promise | What the Product Actually Does | Gap | Severity | Recommended Fix |
|---|---|---|---|---|
| "AI pulls comparable properties" / "Recent assessments and sales of similar homes nearby are gathered and compared" (old page) | The engine's own prompt says, correctly, "you do not have access to a live MLS or county assessor database" | The page sold a live database lookup that does not exist and never did | **Critical** | Fixed in `636136b` — page now says the comparison runs on comparables the customer supplies |
| "The specific comparable properties used as evidence" (old page, What You Get) | Same as above — no comparable was ever pulled by the engine | Same defect, second instance | **Critical** | Fixed in `636136b` |
| Intake: a free-text address box, deployed alongside a server-side gate requiring structured fields | Every submission through the real page was rejected with a message referencing a field the page did not expose | 100% checkout failure between the two deploys | **Critical** | Fixed in `636136b` — structured fields gated client-side by the same engine |
| "The dollar impact of any change" / "Dollar estimate of potential overassessment" | Only computed if the customer supplies a tax rate — an optional field | A customer can pay and receive a report with zero dollar figures, only categorical verdicts | **High** | Make the tax rate effectively required, or default it from a jurisdiction average with a clear "you told us none, so this is a rough estimate" caveat |
| "Get a verdict, not a guess" | Correct on category; not scaled by size. A 6%-above-threshold case and a 40% case both render as "the strongest case … for an appeal" | No minimum-savings judgment — Section 16 of this audit's own brief ("tell customers when an appeal is unlikely to be worth pursuing") is not met | **Medium** | Add a dollar-scaled caveat when `dollarImpact` is known and small (see Required Changes) |
| An assessment rise "alongside a reported physical change" is automatically "likely justified" | True regardless of whether the reported change plausibly explains the size of the increase | A disproportionate increase attached to a minor reported change reads as settled, when it may not be | **Medium** | Disclosed, deliberate limitation given no cost-benchmark table exists (correctly, per [[no-benchmarking-no-state-claims]]) — the fix is language, not data: instruct the write-up to note when the increase looks large relative to a typically modest reported change, without ever stating what the change "should" have cost |
| "What to expect from your local appeal process and deadlines" | Deadlines are only stated if the model is "genuinely confident" about the jurisdiction — otherwise generic | Reasonable given no maintained jurisdiction corpus, but risk of a wrong date if the model overestimates its own confidence is **Unable to verify** without a live run | **Medium** | Default every deadline statement to "confirm the exact date with your assessor's office" regardless of stated confidence, rather than relying on the model correctly gating on its own certainty |
| Look and feel: "another product within the same Stream Navigator product family" as `/closing` | Now true for typography and palette (`navigator-closing-theme.css`); the header still carries `navigator-shared.css`'s colored logo mark and pill-style sub-brand tag, which `/closing` does not use | Minor, deliberate — the commit message calls this a scoped choice, not a site-wide reskin | Low | Optional follow-up if the header treatment is ever unified across all products |

---

## Customer Journey Audit

**1. Landing page.** Clear within 30 seconds: the hero states the problem
("overpaying on property taxes"), the mechanism (compare this year's
assessment to last year's and to comparables you provide), the price ($99),
and proves it with a worked example (a $300k→$360k assessment, no reported
change, ≈$720/year at the customer's own rate — an accurate, non-exaggerated
instance of the engine's own "worth appealing" rule). This is a real
improvement over the old hero, which promised a mechanism ("AI pulls
comparables") the product never had.

**2. Input process.** Six fields now stand in for one free-text box: current
assessed value (required), prior assessed value (recommended), a
physical-change yes/no with optional notes, a factual-error yes/no with
optional notes, an optional tax rate, and up to two optional comparables. The
client-side gate mirrors the server's exactly, so a customer cannot reach a
rejected checkout the way the old page allowed. One friction point: the two
comparable slots are hard-capped at two, and a customer with three or four
strong comps has nowhere to put the others — see Required Changes.

**3. Property lookup / data acquisition.** None, deliberately. The page is
honest that it holds no live assessor or MLS database and asks the homeowner
for the two numbers that are printed on their own assessment notice and tax
bill. This is the correct call given [[no-benchmarking-no-state-claims]] — a
jurisdiction-by-jurisdiction property database is exactly the kind of
capability whose correctness depends on data nobody has committed to
refresh.

**4. Analysis.** Deterministic and disclosed: a factual-error check that
always leads, a year-over-year comparison against a stated 5% materiality
threshold, and a comparison against the customer's own supplied comps against
a stated 10% threshold. Every threshold is disclosed in the finding's own
text (`pct(MATERIAL_CHANGE_THRESHOLD, 0)`, etc.) rather than hidden behind
"typical" language — this is the same discipline `[[no-benchmarking-no-state-claims]]`
required of Closing and HOA, applied here on the codebase's own initiative.

**5. Results / 6. Savings calculation.** Sound where a tax rate is supplied;
silent where it is not. This is the single largest gap between this page's
current promise and its delivery — see Savings Engine Audit.

**7. Recommendation / 8. Next action.** Every finding carries a
`recommendedAction` — "contact the assessor's office and ask specifically how
to correct the record" for a factual error, "bring these specific
comparables to the assessor's office or the appeal board" for the comps
finding. These are concrete next steps, not "consider looking into this."

**9. Pricing / payment.** Verified live, end to end, this session: filling
the real form and clicking through reached Stripe's actual checkout page.
Stopped there, per this audit's rules — no card details were entered and no
charge was made.

---

## Property-Tax Decision Engine Audit

**Strong decision rules:**
- The factual-error finding always leads, unconditionally, regardless of
  what the dollar comparison says — correctly prioritizing the least
  adversarial, most winnable appeal ground.
- Every category (`factual_error`, `worth_appealing`, `requires_documentation`,
  `likely_justified`, `within_norms`) is carried through to the write-up
  verbatim, with an explicit instruction that the model may not recompute,
  reclassify, or add to a finding.
- Comparable-property arithmetic runs only on comparables the customer typed
  in; the write-up prompt is explicit that it may never supplement one "from
  general knowledge, however plausible it would sound." This is the same
  discipline that stopped Home Savings and Home Maintenance from stating a
  "typical" cost, applied correctly here to comparable-sale data.
- A submission with no prior value, no comparables, and no factual error is
  refused a verdict rather than rendered against the current assessment in
  isolation — `COMPARISON_NOT_POSSIBLE` names exactly what is missing.

**Weak or missing decision rules:**
- **No dollar-scaled judgment on whether an appeal is worth pursuing.** The
  engine has a percentage threshold (5% YoY, 10% above comps) but no dollar
  threshold. A `worth_appealing` finding at $40/year and one at $2,000/year
  read identically. Section 16 of this audit's brief asks explicitly for a
  product that can say "do nothing, the potential savings do not justify the
  effort" — this engine cannot yet say that.
- **`physical_changes = true` unconditionally downgrades to `likely_justified`,**
  with no check on proportionality. This is the right default given the
  codebase's commitment to never estimate what an improvement "should" have
  cost, but it means a customer who reports a minor change alongside a large
  increase gets waved off with no further scrutiny.
- **Tax rate is optional**, so a materially large fraction of reports will
  compute no dollar figure at all — see below.
- **The comparable-property check is unweighted by count or dispersion.**
  One comparable and five comparables are treated identically as long as
  the average clears the 10% threshold; a single supplied comp is thinner
  evidence than three, and the write-up has no signal to say so.

---

## Savings Engine Audit

The mechanism is credible where it runs: `dollarImpact = delta * (taxRatePct
/ 100)` is transparent, traceable to two numbers the customer themselves
supplied, and stated to the customer in exactly those terms in the model's
own instructions ("your own assessed value, tax rate, or a finding's own
computed dollarImpact"). A customer asking "why do you believe I could save
approximately $X" can answer it themselves from the same two numbers.

**The problem is coverage, not credibility.** `tax_rate_pct` is the single
input every dollar figure in the report depends on, and it is the one
optional numeric field on the intake form. A customer who supplies a current
value, a prior value, and both yes/no answers — everything the sufficiency
gate requires — but skips the tax rate field receives a complete, valid,
$99 report that states a category ("worth appealing") and a percentage
change, and never states a dollar amount anywhere. That is a real gap against
this audit's Section 9 requirement that a savings estimate be produced, not
merely implied by a percentage.

**Recommendation:** either require `tax_rate_pct` in the sufficiency gate
(it is printed on every tax bill, so the burden is low), or, if it stays
optional, have `navigator-property-tax-engine.js` fall back to a clearly
labeled national or state-average effective rate (~1.1% U.S. average) with
every dollar figure produced that way flagged in the finding itself as an
estimate, not the customer's own number — never silently upgrading an
estimate to read like the customer's own figure. Requiring it is the
simpler, more honest fix and matches how the page already treats it in the
FAQ ("without it, we'll skip that figure rather than guess") — the FAQ is
telling the truth about a design choice that quietly weakens the product.

---

## Evidence Audit

Every figure in a finding traces to a number or answer the customer
themselves typed in — there is no synthesized evidence anywhere in this
engine, which is the entire point of the redesign. Assumptions are disclosed
in-line: the 5% and 10% thresholds are named in every finding's own text, not
buried in a methodology page. Confidence is implicitly binary (a finding
either ran or was explicitly refused with `COMPARISON_NOT_POSSIBLE`) rather
than graded, which is appropriate for arithmetic this simple — there is no
"maybe" in comparing two numbers a customer provided.

**What cannot be verified:** the model's own adherence to its instructions
(never inventing a comparable, never stating a figure it wasn't handed, only
naming a jurisdiction-specific deadline when "genuinely confident") is
**Unable to verify** while the Anthropic account has no credit. The
deterministic half of this product — the part that matters most, per
[[deterministic-audit-is-the-house-pattern]] — is fully verified by 13
engine tests with known answers. The write-up half is not.

---

## Actionability Audit

Every finding a customer can receive carries a category, a plain-language
basis, a concrete recommended action, and — where a tax rate was supplied —
a dollar impact. This clears the bar this audit's Section 10 sets: not "there
may be an issue" but "here is the specific issue, why, and what to do about
it." The gap is upstream of actionability: a customer who never supplied a
tax rate receives an action but no dollar amount to weigh it against, which
is the one piece of information most likely to determine whether they act.

No specific appeal deadline is computed anywhere in this codebase — deadlines
are left to the model's own judgment, gated on its stated confidence about
the jurisdiction. Given deadlines are the one place a wrong or overconfident
answer could cost a customer their entire appeal (a missed deadline is not a
suboptimal outcome, it's a foreclosed one), this is the single spot in the
product where the "genuinely confident" instruction alone is not enough
insurance — see Required Changes.

---

## UX Audit

Verified against `/closing` live, side by side:

- **Typography:** now matches — Newsreader serif headlines, IBM Plex Sans
  body, IBM Plex Mono for the numbered steps, replacing the old Sora/Inter
  pairing shared by the other eight Navigator pages.
- **Color:** now matches — `/closing`'s paper-cream background, navy ink,
  and muted red/green accents, replacing the violet/mint/pink gradient the
  rest of the line still uses.
- **Cards and buttons:** now flat with hairline borders and no offset hard
  shadow, matching `/closing`'s restrained, document-like feel rather than
  the shared template's bolder SaaS styling.
- **Remaining difference:** the header still shows a small colored logo
  mark and a pill-style "Property Tax Navigator" sub-brand badge, inherited
  from `navigator-shared.css`'s shared header markup. `/closing` uses plain
  text ("StreamNavigator / Closing Disclosure Audit") with no icon or pill.
  This is called out explicitly in the commit that did the restyle as a
  scoped choice — "the other eight Navigator pages are untouched" — rather
  than an oversight, and is cosmetic rather than substantive.
- **Mobile:** not separately verified this session; the underlying
  `navigator-shared.css` grid is already responsive across the other nine
  Navigator pages, and this page's changes were CSS-token overrides rather
  than layout changes, so regression risk is low but **Unable to verify**
  without a dedicated pass.

---

## Pricing Audit

**Current Price:** $99, one-time.

**Recommended Price:** $79, one-time.

**Recommended Pricing Model:** one-time (unchanged) — property assessments
change on an annual-at-most cycle in nearly every jurisdiction, there is
nothing to monitor between assessments, and this product is not in
`ENTITLED_PRODUCTS` (only `rental` and `landlord` carry a year of re-runs).
A subscription would sell an ongoing service this product does not render.

**Reasoning:** Line up what `/property-tax` actually does against what its
neighbors charge for real work:

| Product | Price | What it requires of the customer / does |
|---|---|---|
| Insurance Navigator | $79 | Two uploaded documents, extracted and diffed by a real audit engine |
| HOA Navigator | $79 | Uploaded governing documents, 28 checks |
| **Property Tax Navigator** | **$99** | **No document required; arithmetic on up to ~6 numbers/answers the customer types in themselves** |
| Home Maintenance Navigator | $59 | No document required; arithmetic on the customer's own repair/replace quotes — the identical shape to Property Tax |

Property Tax currently charges more than two products that require and
process real uploaded documents, for a product whose most computationally
demanding step is averaging up to two customer-typed numbers. Its closest
mechanical twin in the whole line, Home Maintenance, charges 40% less for
the same shape: no document requirement, customer-supplied figures, a
deterministic categorization engine, a model write-up.

The counter-argument for keeping $99 is real but partial: an appeal, if
successful, saves money every year until the next reassessment, not once —
a genuine advantage over a one-time repair-vs-replace decision. That is worth
something, but not a 68% premium over a mechanically identical product,
especially while the product's own dollar-figure calculation is still gated
behind an optional field (see Savings Engine Audit) — right now a meaningful
share of $99 reports will not state a dollar figure at all.

**$79 is the number that matches what ships today.** If `tax_rate_pct`
becomes effectively required (so every report states a real, traceable
dollar figure) and the comparable-property cap is raised from two to a more
realistic three or four, the recurring-savings argument becomes strong
enough to justify holding at $99 again — write that condition down rather
than treating either number as final, on the same terms
[[audit-prices-are-for-the-unfixed-product]] sets for the rest of this line.

---

## Required Changes

### Critical — Must Fix
*(None remaining — the one critical defect found, the page/engine mismatch
that rejected every checkout, was fixed in `636136b` during this audit and
verified live.)*

### High Priority
1. **Make `tax_rate_pct` effectively required**, or supply a clearly-flagged
   fallback rate, so a paid report is not allowed to ship with zero dollar
   figures when the page's own promise is "the dollar impact of any change."
2. **Cut the price to $79**, on the reasoning above, until the tax-rate gap
   closes and the comparable cap is raised — at which point $99 is earned
   back on its own terms.

### Medium Priority
3. **Add a dollar-scaled caveat** to `worth_appealing` findings: when
   `dollarImpact` is known and small (a reasonable bar: under ~$150/year),
   say plainly that the arithmetic is sound but the amount may not justify
   the effort of an appeal — this is the "tell them to do nothing" capability
   Section 16 of this audit's brief asks for, and the engine has all the data
   it needs to add it without inventing anything.
4. **Default every appeal-deadline statement to "confirm the exact date with
   your assessor's office,"** regardless of the model's stated confidence
   about the jurisdiction — a wrong deadline forecloses the appeal entirely,
   which is a worse failure mode than a generic checklist.
5. **Raise the comparable-property cap from two to three or four** slots —
   thin evidence is a real limitation for a customer who did the legwork of
   finding more.
6. **Add a page-copy regression test** (mirroring the existing
   `tests/claims.test.js` pattern) asserting `property-tax.html` never
   reintroduces "AI pulls," "gathered," or "the specific comparable
   properties used as evidence" — cheap insurance against the exact defect
   this audit's first finding was.

### Low Priority
7. Disclose in the FAQ or upload copy that an uploaded assessment notice is
   quoted in the write-up but never changes a finding — matching how
   Insurance and Home Savings already describe their own upload role.
8. Consider unifying the header (logo mark, sub-brand pill) with `/closing`'s
   plain-text pattern if a full header pass is ever done across the line;
   not worth a one-off change for this page alone.

---

## Recommended Product Specification

**Inputs (unchanged from `636136b`, plus one required-field change):**
address (context only, not analyzed), current assessed value (required),
prior assessed value (recommended, part of the baseline gate), physical
change yes/no + notes, factual error yes/no + notes, tax rate (**recommend
required**, currently optional), up to three or four comparable
address/value pairs (currently two), optional file upload (quoted only,
never analyzed).

**Data sources:** none external. Deliberately no live assessor/MLS
integration and no jurisdiction rate corpus, consistent with
[[no-benchmarking-no-state-claims]] — every figure traces to the customer's
own input.

**Calculations:** year-over-year delta and percentage against a disclosed
5% materiality threshold; comparable-average delta and percentage against a
disclosed 10% threshold; dollar impact as `delta × tax rate`, computed
whenever a rate exists (recommend: always, once required).

**Decision rules:** factual error always leads; year-over-year change
categorized `within_norms` (<5%), `likely_justified` (≥5%, physical change
reported), or `worth_appealing` (≥5%, no reported change); comparables
categorized `worth_appealing` at ≥10% above the customer's own comp average;
no baseline → refused rather than guessed. Recommended addition: a
dollar-scaled "may not be worth pursuing" caveat under a stated threshold.

**Evidence:** every comparable and every dollar figure traces directly to a
customer-supplied number, quoted rather than estimated, with the disclosed
threshold stated alongside each finding.

**Output:** a factual-error section (if applicable) leading regardless of
dollar figures; a year-over-year finding; a comparables finding (if
comparables were supplied); a dollar impact for each (once tax rate is
required); a generalized appeal checklist, state/county-specific only when
genuinely confident, with a standing instruction to confirm any stated
deadline directly with the assessor's office regardless of that confidence.

**Pricing:** $79, one-time, per property. Revisit to $99 once the tax-rate
and comparable-cap changes ship.

---

## Final Customer-Value Test

> **If I were a rational property owner paying the recommended price, would
> I reasonably expect this product to save me more money than it costs by
> identifying a legitimate opportunity to reduce an unnecessarily high
> property-tax burden?**

### Customer Value Assessment

**Yes, at $79 — and no longer trivially, at $99, until the tax-rate gap
closes.** The engine that ships today does something real and honest: it
takes two numbers most homeowners already have on hand, applies disclosed,
non-invented thresholds, and tells them plainly whether they have a case —
including telling them plainly when they don't (`within_norms`,
`likely_justified`). It will not invent a comparable or a dollar figure, and
a factual error — the cheapest, fastest win available to a homeowner — is
never buried under a dollar comparison. That is a legitimate, if modest,
service: turning "you could look into this yourself" into "here is your
case, in five minutes, for a price that pays for itself many times over if
you act on a real finding." The math checks out even in the low-end scenario
this audit's own framework asks for: a bare 5%-threshold increase on a
$300,000 home at a 1.1% effective rate is about $165/year, recovered for
more than one year if the appeal holds until the next reassessment — a
multiple of even the current $99 price, assuming the appeal succeeds, which
this product cannot promise and correctly never claims to.

The reason the answer is qualified rather than unqualified: at today's $99,
and with the tax rate still optional, a real share of customers will pay
full price and receive a report with a correct category and no dollar
figure at all — the exact thing a rational buyer is paying to learn. That is
fixable without inventing anything the codebase has committed not to invent,
and it is the highest-leverage change available.

### Recommended Product

The product described in Recommended Product Specification, above: the
current engine, with the tax rate made effectively required, a dollar-scaled
"not worth pursuing" caveat added, deadlines always hedged toward "confirm
with your assessor," and the comparable cap raised to three or four.

### Recommended Price

**$79, one-time, per property.**

### Highest-Impact Fix

**Require the tax rate.** Every other piece of this product — the
categorization, the factual-error lead, the comparable comparison — already
works and is already honest. The one input standing between "a correct
categorical verdict" and "a correct categorical verdict plus the dollar
figure the entire page is sold on" is one optional number field. Closing
that gap does more for customer value than any other single change in this
report, at effectively zero engineering cost.
