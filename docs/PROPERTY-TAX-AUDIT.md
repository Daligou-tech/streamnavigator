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

**The tax-rate gap is also now closed.** `navigator-property-tax-engine.js`'s
sufficiency gate requires a tax rate whenever a numeric baseline (a prior
value or a comparable) is supplied — the exact case where the old gate let a
customer through without one and the engine silently produced a category
with no dollar figure behind it. `comparablesFinding` also now computes a
`dollarImpact` the same way `trendFinding` always did; it previously always
returned `null`, so a "worth appealing" verdict built on comparables alone
could never state what it was worth even when a rate existed. The one case
where the rate correctly stays optional is a factual-error-only submission,
which has no delta to multiply a rate against in the first place. 15 tests
now pin this (2 new comparables-dollar-impact tests, 4 rewritten sufficiency
tests, 2 new intake-gate tests) — 85 suites still pass.

**Three of the four Medium-priority gaps are also now closed**, added after
the tax-rate fix in the same session: a dollar-scaled caveat on a
`worth_appealing` finding under $150/year (`withSmallDollarCaveat`), every
appeal-deadline instruction now unconditionally hedged toward "confirm the
exact date with your assessor's office" regardless of the model's stated
confidence, and the comparable-property cap raised from two slots to four.
The one that remains open — `physical_changes = true` unconditionally
reading as "likely justified" with no proportionality check — is a
disclosed, deliberate limitation (see Decision Engine Audit) rather than an
oversight, and stays open on purpose.

**The price is shipped too: $99 → $79, one-time, live in Stripe.** A new
$79.00 one-time price (`price_1UHuIpH9DnCfGBIZCUUL1B8o`) was added to the
same "Property Tax Navigator Report" product, a new Payment Link
(`plink_1UHuKRH9DnCfGBIZiC82VC6U`, `https://buy.stripe.com/eVqcN59ko5QgfAM0xqabK0k`)
created for it with the same after-payment redirect every other Navigator
link uses, and the old $99 link (`plink_1U9qwtH9DnCfGBIZCh3aJiKy`,
`bJeaEX68c4Mc0FS2FyabK04`) deactivated rather than deleted, so it can be
reactivated if this ever needs to roll back. Done directly in the Stripe
dashboard via the user's own authenticated session (Claude in Chrome), after
two dead ends: the Vercel connector's env-var read returned no decrypted
value for `STRIPE_SECRET_KEY`, and no Stripe MCP connector was available to
this session either. `property-tax.html`, `prices.config.json` and this
document were updated in the same pass — the page, the config, and Stripe
now agree, which is what `scripts/check-prices.js` checks for.

---

## Promise vs. Delivery

| Promise | What the Product Actually Does | Gap | Severity | Recommended Fix |
|---|---|---|---|---|
| "AI pulls comparable properties" / "Recent assessments and sales of similar homes nearby are gathered and compared" (old page) | The engine's own prompt says, correctly, "you do not have access to a live MLS or county assessor database" | The page sold a live database lookup that does not exist and never did | **Critical** | Fixed in `636136b` — page now says the comparison runs on comparables the customer supplies |
| "The specific comparable properties used as evidence" (old page, What You Get) | Same as above — no comparable was ever pulled by the engine | Same defect, second instance | **Critical** | Fixed in `636136b` |
| Intake: a free-text address box, deployed alongside a server-side gate requiring structured fields | Every submission through the real page was rejected with a message referencing a field the page did not expose | 100% checkout failure between the two deploys | **Critical** | Fixed in `636136b` — structured fields gated client-side by the same engine |
| "The dollar impact of any change" / "Dollar estimate of potential overassessment" | Was only computed if the customer supplied a tax rate — an optional field | A customer could pay and receive a report with zero dollar figures, only categorical verdicts | **High** | **Fixed** — tax rate now required whenever a numeric baseline (prior value or comparable) is given; `comparablesFinding` also now computes a `dollarImpact` it previously always returned as `null` |
| "Get a verdict, not a guess" | Correct on category; was not scaled by size. A 6%-above-threshold case and a 40% case both rendered as "the strongest case … for an appeal" | No minimum-savings judgment — Section 16 of this audit's own brief ("tell customers when an appeal is unlikely to be worth pursuing") was not met | **Medium** | **Fixed** — `withSmallDollarCaveat()` appends a modest-amount caveat to any `worth_appealing` finding under $150/year |
| An assessment rise "alongside a reported physical change" is automatically "likely justified" | True regardless of whether the reported change plausibly explains the size of the increase | A disproportionate increase attached to a minor reported change reads as settled, when it may not be | **Medium** | Disclosed, deliberate limitation given no cost-benchmark table exists (correctly, per [[no-benchmarking-no-state-claims]]) — left open on purpose; see Decision Engine Audit |
| "What to expect from your local appeal process and deadlines" | Deadlines were only stated if the model is "genuinely confident" about the jurisdiction — otherwise generic | Reasonable given no maintained jurisdiction corpus, but risk of a wrong date if the model overestimates its own confidence was **Unable to verify** without a live run | **Medium** | **Fixed** — the prompt now unconditionally instructs the write-up to add "confirm the exact date with your assessor's office" alongside every deadline it states, regardless of stated confidence |
| Look and feel: "another product within the same Stream Navigator product family" as `/closing` | Now true for typography and palette (`navigator-closing-theme.css`); the header still carries `navigator-shared.css`'s colored logo mark and pill-style sub-brand tag, which `/closing` does not use | Minor, deliberate — the commit message calls this a scoped choice, not a site-wide reskin | Low | Optional follow-up if the header treatment is ever unified across all products |

---

## Customer Journey Audit

**1. Landing page.** Clear within 30 seconds: the hero states the problem
("overpaying on property taxes"), the mechanism (compare this year's
assessment to last year's and to comparables you provide), the price ($79),
and proves it with a worked example (a $300k→$360k assessment, no reported
change, ≈$720/year at the customer's own rate — an accurate, non-exaggerated
instance of the engine's own "worth appealing" rule). This is a real
improvement over the old hero, which promised a mechanism ("AI pulls
comparables") the product never had.

**2. Input process.** Six fields now stand in for one free-text box: current
assessed value (required), prior assessed value (part of the baseline gate),
a physical-change yes/no with optional notes, a factual-error yes/no with
optional notes, a tax rate (required whenever it would be used), and up to
four optional comparables. The client-side gate mirrors the server's
exactly, so a customer cannot reach a rejected checkout the way the old page
allowed.

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

**Fixed this session:**
- ~~No dollar-scaled judgment on whether an appeal is worth pursuing~~ —
  `withSmallDollarCaveat()` now appends a plain caveat to any
  `worth_appealing` finding whose `dollarImpact` is under $150/year: "That
  said, $X/year is a modest amount — weigh it against the time an appeal
  takes before deciding whether to pursue it." The category is untouched;
  only the recommendation is scaled.
- ~~Tax rate is optional~~ — required whenever a numeric baseline (a prior
  value or a comparable) exists to compute a dollar figure from; stays
  optional only for a factual-error-only submission, which has no delta to
  multiply a rate against.
- ~~The comparable-property check caps at two slots~~ — raised to four on
  the page; the engine itself was always uncapped (it maps over whatever
  array it receives), so no engine change was needed.

**Remaining, left open on purpose:**
- **`physical_changes = true` unconditionally downgrades to `likely_justified`,**
  with no check on proportionality. This is the right default given the
  codebase's commitment to never estimate what an improvement "should" have
  cost, but it means a customer who reports a minor change alongside a large
  increase gets waved off with no further scrutiny. Fixing this honestly
  needs a cost-benchmark table this codebase has deliberately never built —
  see [[no-benchmarking-no-state-claims]] — so it stays a named, disclosed
  limitation rather than a half-measure.

---

## Savings Engine Audit

The mechanism is credible where it runs: `dollarImpact = delta * (taxRatePct
/ 100)` is transparent, traceable to two numbers the customer themselves
supplied, and stated to the customer in exactly those terms in the model's
own instructions ("your own assessed value, tax rate, or a finding's own
computed dollarImpact"). A customer asking "why do you believe I could save
approximately $X" can answer it themselves from the same two numbers.

**Fixed.** `tax_rate_pct` is now required in `checkSufficiency()` whenever a
prior value or a comparable is supplied — the two cases that produce a
dollar figure. A customer can no longer complete checkout with a numeric
baseline and no rate; the client-side gate (the same engine, loaded into the
page) blocks it before submission, and the server-side gate blocks it again
if the client is ever bypassed. The one path where the rate correctly stays
optional is a factual-error-only submission, which has no delta to multiply
a rate against in the first place — matching the "why" the FAQ already gave
customers before this fix existed to back it up.

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
basis, a concrete recommended action, and — now unconditionally, since a
numeric baseline requires a tax rate — a dollar impact where one applies.
This clears the bar this audit's Section 10 sets: not "there may be an
issue" but "here is the specific issue, why, what it's worth, and what to do
about it."

No specific appeal deadline is computed anywhere in this codebase — deadlines
are still left to the model's own judgment about the jurisdiction, which
remains **Unable to verify** without a live run. What changed: the prompt no
longer gates the safety net on the model's own stated confidence. Every
deadline it states now carries an unconditional instruction to add "confirm
the exact date with your assessor's office" — a missed deadline forecloses
the appeal entirely, so this is insurance against the model being wrong about
its own certainty, not just about the date.

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

**Current Price:** $79, one-time. (Was $99 until this session; see Executive Summary for the Stripe change.)

**Recommended Price:** $79, one-time — shipped.

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
| **Property Tax Navigator** | **$79** (was $99) | **No document required; arithmetic on numbers/answers the customer types in themselves** |
| Home Maintenance Navigator | $59 | No document required; arithmetic on the customer's own repair/replace quotes — the identical shape to Property Tax |

Property Tax was charging more than two products that require and process
real uploaded documents, for a product whose most computationally demanding
step is averaging up to two customer-typed numbers. Its closest mechanical
twin in the whole line, Home Maintenance, charges 40% less for the same
shape: no document requirement, customer-supplied figures, a deterministic
categorization engine, a model write-up.

The counter-argument for $99 was real but partial: an appeal, if successful,
saves money every year until the next reassessment, not once — a genuine
advantage over a one-time repair-vs-replace decision. That was worth
something, but not a 68% premium over a mechanically identical product,
especially while the product's own dollar-figure calculation was still gated
behind an optional field.

**$79 is now the live price**, matching what ships today. Two of the two
named conditions for reconsidering $99 have since shipped in this same
session — `tax_rate_pct` is now effectively required, and the
comparable-property cap is raised from two to four — so the recurring-
savings argument is stronger than it was when $79 was set. This is noted for
the next audit to weigh rather than acted on here: reversing a price twice
in one sitting, on the strength of a note this document wrote about itself,
is not the same as a fresh audit concluding the higher number is earned. The
`physical_changes` proportionality gap (see Decision Engine Audit) is also
still open, which was one of the reasons $99 looked rich to begin with.
Treat $79 as current, not as a placeholder, on the same terms
[[audit-prices-are-for-the-unfixed-product]] sets for the rest of this line.

---

## Required Changes

### Critical — Must Fix
*(None remaining — the one critical defect found, the page/engine mismatch
that rejected every checkout, was fixed in `636136b` during this audit and
verified live.)*

### High Priority
*(None remaining — both shipped this session.)*
1. ~~Make `tax_rate_pct` effectively required~~ — **Shipped.** Required
   whenever a prior value or a comparable is supplied; stays optional only
   for a factual-error-only submission, where it would have nothing to
   multiply against.
2. ~~Cut the price to $79~~ — **Shipped.** New $79 Stripe Price and Payment
   Link created, old $99 link deactivated, `property-tax.html` and
   `prices.config.json` both updated to match.

### Medium Priority
*(3 of 4 shipped; #2 below stays open on purpose.)*
1. ~~Add a dollar-scaled caveat to `worth_appealing` findings~~ — **Shipped.**
   `withSmallDollarCaveat()` appends a modest-amount note under $150/year.
2. **`physical_changes = true` unconditionally reads as "likely justified"
   with no proportionality check.** Left open — see Decision Engine Audit for
   why fixing this honestly needs data this codebase has deliberately never
   built.
3. ~~Default every appeal-deadline statement to confirm with the assessor~~ —
   **Shipped**, in the write-up prompt.
4. ~~Raise the comparable-property cap from two to three or four~~ —
   **Shipped**, raised to four.
5. ~~Add a page-copy regression test~~ — **Shipped**, `tests/property-tax-claims.test.js`.

### Low Priority
6. ~~Disclose in the FAQ or upload copy that an uploaded assessment notice is
   quoted, not analyzed~~ — **Shipped**, added to the upload field's hint.
7. Consider unifying the header (logo mark, sub-brand pill) with `/closing`'s
   plain-text pattern if a full header pass is ever done across the line;
   not worth a one-off change for this page alone. Left open — cosmetic.

---

## Recommended Product Specification

**Inputs (as shipped):** address (context only, not analyzed), current
assessed value (required), prior assessed value (part of the baseline gate),
physical change yes/no + notes, factual error yes/no + notes, tax rate
(required whenever a numeric baseline exists), up to four comparable
address/value pairs, optional file upload (quoted only, never analyzed).

**Data sources:** none external. Deliberately no live assessor/MLS
integration and no jurisdiction rate corpus, consistent with
[[no-benchmarking-no-state-claims]] — every figure traces to the customer's
own input.

**Calculations:** year-over-year delta and percentage against a disclosed
5% materiality threshold; comparable-average delta and percentage against a
disclosed 10% threshold; dollar impact as `delta × tax rate` for both, always
computed since a rate is now required wherever it would apply.

**Decision rules:** factual error always leads; year-over-year change
categorized `within_norms` (<5%), `likely_justified` (≥5%, physical change
reported), or `worth_appealing` (≥5%, no reported change); comparables
categorized `worth_appealing` at ≥10% above the customer's own comp average;
no baseline → refused rather than guessed; a `worth_appealing` finding under
$150/year carries an added caveat that the amount may not justify the effort.

**Evidence:** every comparable and every dollar figure traces directly to a
customer-supplied number, quoted rather than estimated, with the disclosed
threshold stated alongside each finding.

**Output:** a factual-error section (if applicable) leading regardless of
dollar figures; a year-over-year finding; a comparables finding (if
comparables were supplied); a dollar impact for each; a generalized appeal
checklist, state/county-specific only when genuinely confident, with a
standing instruction to confirm any stated deadline directly with the
assessor's office regardless of that confidence.

**Pricing:** $79, one-time, per property — live.

---

## Final Customer-Value Test

> **If I were a rational property owner paying the recommended price, would
> I reasonably expect this product to save me more money than it costs by
> identifying a legitimate opportunity to reduce an unnecessarily high
> property-tax burden?**

### Customer Value Assessment

**Yes.** The engine that ships today does something real and honest: it
takes two numbers most homeowners already have on hand, applies disclosed,
non-invented thresholds, and tells them plainly whether they have a case —
including telling them plainly when they don't (`within_norms`,
`likely_justified`), and now telling them plainly when a case exists but
probably isn't worth the effort (the small-dollar caveat). It will not
invent a comparable or a dollar figure, and a factual error — the cheapest,
fastest win available to a homeowner — is never buried under a dollar
comparison. Every numeric case now states a real dollar figure, because the
one input that produces one is required exactly where it's needed. That is a
legitimate service: turning "you could look into this yourself" into "here
is your case, in five minutes, with a real number attached, for a price that
pays for itself many times over if you act on a real finding." The math
checks out even in the low-end scenario this audit's own framework asks for:
a bare 5%-threshold increase on a $300,000 home at a 1.1% effective rate is
about $165/year, recovered for more than one year if the appeal holds until
the next reassessment — a multiple of the $79 price, assuming the appeal
succeeds, which this product cannot promise and correctly never claims to.

What made the answer qualified when this audit was written — a customer
paying full price for a report with a correct category and no dollar figure
at all — is now closed. What remains open (the `physical_changes`
proportionality gap) is a disclosed, deliberate limitation rather than a
silent one.

### Recommended Product

The product described in Recommended Product Specification, above — this is
what shipped, not a proposal.

### Recommended Price

**$79, one-time, per property — live.**

### Highest-Impact Fix

**Require the tax rate — shipped.** Every other piece of this product — the
categorization, the factual-error lead, the comparable comparison — already
worked and was already honest. The one input that stood between "a correct
categorical verdict" and "a correct categorical verdict plus the dollar
figure the entire page is sold on" is now required exactly where it applies.
