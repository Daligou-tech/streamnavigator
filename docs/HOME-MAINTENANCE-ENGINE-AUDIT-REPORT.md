# STREAM NAVIGATOR — HOME MAINTENANCE ENGINE AUDIT REPORT

**Status, 2026-09-20 (same day): all eight Required Changes below have
shipped, including the price change end to end.** The two Critical fixes
(the silent category default, the thin-result refund), the price cut to
$39, the material/type question, the prior-repair signal, and the
design/font cleanup are all live in the repository. The new $39 Stripe
Price and Payment Link (`buy.stripe.com/eVqfZh2W0diI4W80xqabK0l`) were
created on the existing "Home Maintenance Navigator Report" product and
wired into `home-maintenance.html`/`prices.config.json` via
`scripts/set-home-maintenance-link.js`; the old $59 link
(`buy.stripe.com/28EeVd9ko3I80FS1BuabK09`) is deactivated in Stripe, not
deleted. `npm run check-prices` confirms all 11 checked pages, including
this one, are consistent.

Conducted 2026-09-20 against `/home-maintenance` and `/closing` on the live
site, `navigator-home-maintenance-engine.js`, `api/_lib/navigator-engine.js`,
`api/navigator-intake.js`, `prices.config.json`, and `tests/` at the
repository's current `main`. This is a second, broader pass over a product
that was already audited once today — `docs/HOME-MAINTENANCE-AUDIT.md`
(committed `330217b`/`6b7ca43`) found and fixed a critical defect: a single
model call told to invent "typical cost ranges" it had no data for. That fix
is live, tested, and confirmed working in this audit. This report does not
re-litigate that finding. It applies a wider lens — evidence-scoring
discipline, cross-product pricing consistency, the live customer journey
end-to-end, and a design comparison against `/closing` — and it surfaces
findings the narrower audit did not go looking for, including one new
critical defect and one confirmed live UI bug.

## Access Limitations

**Level 1 (direct access) achieved in full.** The live page was loaded,
scripted, and interacted with — button clicks, form fills, and a real
sufficiency-gate rejection were all observed directly in the browser, not
inferred from code. `navigator-home-maintenance-engine.js`,
`api/_lib/navigator-engine.js`, `api/navigator-intake.js`, and
`prices.config.json` were read in full. The repository's test suite (86
suites) and the product's own decision harness
(`scripts/home-maintenance-audit-harness.js`, 7 scenarios) were both run live
this session and passed / produced the outputs quoted below.

**What was not done, on purpose:** no Stripe payment was completed (per this
audit's financial-safety rules) and no paid LLM write-up was generated (the
Anthropic account has been out of credit since 2026-09-13 —
`[[no-api-credit-topups]]` — and the prior audit already established that
live report generation is the one thing this product needs a model call for
at all). Everything **upstream** of the write-up — the verdict, the sufficiency
gate, the pricing wiring, the checkout handoff — is Verified by direct
execution, not by reading code and assuming it runs. The **write-up step
itself** (does the model, handed the computed verdict, present it without
softening or embellishing it) remains Unverified, exactly as the prior audit
disclosed, and is not re-litigated here.

---

## Executive Summary

**What works:** the deterministic core is sound and does what it says. The
single Critical defect the earlier audit found — a model inventing "typical
cost ranges" from nowhere — is fixed, tested (20 unit tests, all passing),
and verified live: submitting the FAQ's own water-heater example through the
actual engine on this machine returns the exact verdict the page advertises.
The safety override is unconditional and cannot be reached by cost logic in
any test case. The product refuses to manufacture a financial verdict when
the customer hasn't supplied the numbers to compute one — a genuine, tested
"we will not guess" path that most of this audit's frameworks exist to
demand. Nothing on the page claims an insurance benefit, an efficiency
saving, or a cost-of-ownership figure it doesn't compute — the prior audit
already cut those claims, and they have not crept back.

**What is materially weak or broken, found in this pass — all fixed same-day; see Required Changes for what shipped:**

1. **A confirmed live UI bug lets a customer pay for the wrong system's
   report without ever knowing it.** The category selector shows no default
   selection on page load — no chip is visually active — but the underlying
   script silently defaults to `"Roof"` regardless. A customer deciding
   about a water heater or a generator who fills in every other field and
   never happens to click a category chip will submit, and be charged $59
   for, a Roof analysis. This cannot be caught by the sufficiency gate,
   because `"Roof"` is a valid category value. **Verified live** on this
   session's fresh page load.
2. **No thin-result safeguard exists for the one outcome this product
   explicitly, deliberately sells: a $59 report with no financial verdict in
   it.** A customer can check "I don't have a quote for either yet" — an
   answer the product calls "honestly scoped, not blocked" in its own test
   suite — pay $59, and receive nothing but a boilerplate age-range sentence
   and a static, category-level checklist. Two sibling products in this same
   codebase (Government Money Finder, Contractor Navigator) already
   auto-refund exactly this shape of outcome. Home Maintenance has no such
   trigger anywhere in its code.
3. **The price sits above two mechanically more complex siblings.** Contractor
   Navigator ($49) extracts real uploaded documents and checks them against a
   held reference database of statutory caps and published cost ranges —
   more real work, for less money. Government Money Finder ($39) runs a
   larger deterministic rules engine against a bigger reference table, for a
   third less money. Home Maintenance's engine (285 lines) is the smallest
   and simplest of the four self-serve deterministic engines in this
   product line, has no document-extraction step, holds no external
   reference-cost database, and confers no recurring benefit — yet costs
   more than two products that do more.

**Biggest customer-value problem:** #2 above. A product whose own honesty
discipline is its main selling point (never guess a cost) currently has no
mechanism to stop itself from charging full price for an answer that isn't
one.

**Biggest product opportunity:** the product is honestly scoped as a
single-decision repair-vs-replace calculator, not the broader "which
maintenance is worth doing, and when, across my whole house" advisor this
audit's own brief assumes as the category's ideal. That narrower scope is
not a truthfulness problem — the page never claims to do more — but it is a
real ceiling on customer value. See Recommended Product Specification.

**Is the current price justified?** No. **Recommended price: $39, one-time**
(down from $59) — see Pricing Audit.

---

## Promise vs. Delivery

| Promise | What the Product Actually Does | Gap | Severity | Recommended Fix |
|---|---|---|---|---|
| "Get a clear repair-vs-replace recommendation grounded in real numbers" (H1) | Verified: `analyze()` computes the ratio purely from the customer's own `repair_quote`/`replacement_quote`; no dollar figure is invented anywhere in the engine or the write-up prompt | None — this is the one promise the prior audit's fix was built to keep, and it holds | — | None needed |
| "What you get": a repair-or-replace call "using your own quoted numbers" | True when both quotes are given. When neither is given, the customer instead gets a boilerplate age sentence and a static checklist — still charged $59 | The bullet is true on average, false for a disclosed-but-real subset of paying customers | High | Auto-refund the `NEED_BOTH_QUOTES` outcome (see Required Changes #1) |
| "Roof, HVAC, water heater, windows, generator — tell StreamNavigator what you're deciding on" (implies the category you pick is the category you get) | Verified live: no category chip is visually active on page load; the script defaults to `"Roof"` silently if none is clicked | A customer can be charged for the wrong system's analysis without any indication of the mistake | **Critical** | Remove the silent default (see Required Changes #2) |
| "One price. One repair-or-replace decision." / $59 one-time | Verified end-to-end: page copy, `prices.config.json` (`5900` cents), the live Stripe Payment Link (`buy.stripe.com/28EeVd9ko3I80FS1BuabK09`), and the webhook all agree — a genuine one-time charge, no subscription anywhere in the wiring | None on mechanism. The **amount** is out of line with sibling products doing more work for less (see Pricing Audit) | High | Cut to $39, one-time |
| "Where your system's age sits against a typical service-life range for its category" | True, but the range assumes one material per category (e.g. asphalt shingle for Roof) and the intake never asks which material the customer actually has, even though the engine's own caveat names material as the dominant variable | The one non-customer-supplied fact in the report is disclosed as approximate but could be sharpened cheaply | Medium | Add a one-chip material/type question for Roof and Water Heater |
| Implicit: the product is the comprehensive "what maintenance is worth doing, house-wide" advisor this audit's brief assumes | Explicitly, honestly narrower: one system, one decision, per $59 report — the page never claims otherwise | Not a truthfulness gap (the page doesn't overclaim), but a ceiling on total addressable value | — (opportunity, not a defect) | See Recommended Product Specification |
| Visual/brand promise: "another product in the same Stream Navigator family" as `/closing` | Close but not identical — same fonts, ink/paper palette, and flat pricing-card treatment; still carries a colored logo-mark icon and a pill sub-brand badge `/closing` doesn't have, plus two unused font families loaded for no reason | Cosmetic, already flagged and deliberately deferred on the sibling `/property-tax` page in `docs/PROPERTY-TAX-AUDIT.md` | Low | Drop the logo mark/pill badge; remove the dead Inter/Sora `<link>` tags |

---

## Customer Journey Audit

**1. Landing page.** The hero states the problem ("Repair it or replace it?"),
the mechanism ("tell StreamNavigator what you're deciding on... grounded in
real numbers"), and proves it with a worked example (14-year-old water
heater, $1,400 vs. $2,600, badge "Replace") before asking for anything. This
is a genuinely strong pattern: the visitor sees the actual mechanism running
on real numbers before being asked to trust it. Understandable in well under
30 seconds. **Verified live.**

**2–3. Inputs / property information.** Structured chips and number fields —
category, age (or "not sure"), what's prompting the decision, repair quote,
replacement quote (or "I don't have one yet"), optional notes, optional
file upload, email. Every field earns its place: category and symptoms
gate the analysis path, age drives the lifespan comparison, the quotes
drive the only financial claim the product makes. Nothing asks for
information the product doesn't use. **One defect found here: the category
chip has no visible default and silently resolves to "Roof" if skipped —
see Executive Summary #1.** **Verified live.**

**4–5. Maintenance analysis / prioritization.** Not applicable in the sense
the audit brief assumes (there is no multi-item priority list — this product
analyzes exactly one system per report), and the page never claims
otherwise. Within its scope, there is a real, tested priority order: safety
concern > cost comparison > "we need more information." That ordering is
correct and unconditional (see Decision Engine Audit).

**6. Cost analysis.** Arithmetic only, on the customer's own two numbers,
against a disclosed 50% threshold. No invented cost anywhere. **Verified**
via direct engine execution (harness output below).

**7–8. Results / recommendation.** The write-up prompt
(`api/_lib/navigator-engine.js:459-471`) is tightly bound to the computed
verdict — it is explicitly forbidden from stating a dollar figure that
isn't the customer's own, from softening a safety verdict, or from filling a
missing-quote gap with generic advice "dressed up as a recommendation."
**Unverified in a live paid run** (no model credit available this session),
but the prompt itself, read directly, leaves very little room for drift.

**9. Next action.** Every verdict path ends at a concrete instruction: call a
professional now (safety), get one more quote (missing-quote states), or
here's your answer plus a contractor question checklist (both-quotes states).
No verdict path ends in vague advice.

**10. Pricing/payment.** Verified live, end to end, this session: filling the
real form with an intentionally incomplete submission produced the exact
inline rejection the engine's `checkSufficiency()` computes
("Enter the system's age, or mark it unknown.") without navigating away —
confirming the client-side gate actually runs, not just that it exists in
source. The page's own error-handling detail (an inline message that
survives a reload, rather than a toast that clears after 3.6 seconds — see
`home-maintenance.html:216-220`) is a real, deliberate usability fix, and it
worked as designed.

---

## Maintenance Decision Engine Audit

**Verdict logic (`navigator-home-maintenance-engine.js:186-237`), confirmed
by direct execution this session:**

```
the FAQ's own example — 14yo water heater, $1,400 vs $2,600
  verdict: replace
  reason:  The repair quote ($1,400) is 54% of the replacement quote ($2,600)
           — at or above the 50% threshold where replacing is usually the
           better value.
  age:     14 yrs vs typical 8-12 (past range: true)

safety concern overrides a dramatically cheap repair ($200 repair vs $8,000 replace)
  verdict: urgent_safety
  cost comparison: null  <- cost math never ran

no quotes at all, age unknown
  verdict: need_both_quotes
  reason:  No repair or replacement quote was provided, so no financial
           recommendation can be made yet.
```

**Strong decision rules:**
- **Safety always wins, unconditionally.** `applySafetyOverride()` runs
  first and returns a terminal result; the cost-comparison branch is
  structurally unreachable once `safety_concern` is flagged, confirmed by a
  test that deliberately makes repair look dramatically cheaper ($200 vs.
  $8,000) and shows the verdict is still `urgent_safety` with
  `costComparison: null`. This is exactly the evidence-threshold behavior
  Section 12 of this audit's own framework calls for: an irreversible,
  safety-relevant outcome gets acted on regardless of how weak the
  underlying evidence is (a self-reported symptom checkbox), because the
  cost of a false positive (an unnecessary service call) is trivial next to
  the cost of a false negative.
- **The repair-vs-replace threshold is disclosed, not hidden.** Every verdict
  states the exact ratio and the exact threshold in plain language
  ("$1,400 is 54% of $2,600 — at or above the 50% threshold"). A customer
  can check the engine's own math against a calculator in ten seconds.
- **A missing quote never gets filled with a guess.** Three distinct verdicts
  (`NEED_REPAIR_QUOTE`, `NEED_REPLACEMENT_QUOTE`, `NEED_BOTH_QUOTES`) exist
  for exactly this, and the write-up prompt is explicitly forbidden from
  papering over them with generic advice.

**Weak or missing decision rules:**
- **The lifespan-range table doesn't ask the one variable it names as the
  reason it might be wrong.** `LIFESPAN_RANGES['Roof']` assumes asphalt
  shingle and says so in its own caveat; `Water Heater` assumes a
  storage-tank unit and says tankless units last 15-20 years instead of 8-12
  — nearly double. The intake never asks which the customer has. The
  caveat is honest, but the product could simply ask and stop needing the
  caveat to do so much work. **Evidence Strength for this table's
  applicability to a specific customer: 3/5** (Moderate — a well-established
  general range, but a material variable that would change the answer is
  known to the engine and not collected).
- **The 50% threshold is a single, un-nuanced heuristic.** It does not
  account for financing cost, energy-efficiency savings from replacing, or
  warranty differences — and, correctly, the page no longer claims it does
  (the prior audit removed the "efficiency and cost-of-ownership
  differences" bullet rather than fake it). This is an honest limitation,
  not a truthfulness violation, but it caps how sophisticated a "real
  economics" claim can be.
- **No repair-vs-replace nuance for a system that has already failed once
  before.** The intake never asks "has this been repaired before," which is
  one of the single strongest real-world signals for "replace" that a
  customer could supply for free. This is a missed low-cost, high-value
  input.

**Incorrect or dangerous assumptions:** none found. The one thing this file's
own header calls out as a considered exception (using service-life years,
never cost, as context) is followed consistently in the code and in the
write-up prompt's hard rules; it does not blur into a cost claim anywhere
tested.

---

## Savings Engine Audit

There is no "savings" claim on this page at all, and that restraint is
itself a finding worth stating plainly: the product does not compute or
display an estimated dollar savings figure anywhere, unlike several sibling
products. **This is correct, not a gap.** A believable savings number for
"which of two customer-supplied quotes is cheaper" would just be
`abs(repairQuote - replacementQuote)` — trivial, and stating it as "your
savings" would imply the product found something, when the customer already
had both numbers in hand. The product's actual value is not a savings
calculation; it is (a) a disclosed decision rule applied consistently, (b)
service-life context, (c) a safety triage step, and (d) a contractor
question checklist. All four are delivered when the inputs support them.

**Where the real economic value is, and where it is not:** for a customer
who already has both quotes, the marginal value StreamNavigator adds beyond
what a free web search for "50% rule repair or replace" would tell them in
under a minute is genuinely modest — consistent application of a known
threshold, service-life framing, and a checklist. That value is real but
should be priced like what it is (see Pricing Audit), not like a document
audit that catches errors a customer could not have found alone.

---

## Maintenance Schedule Audit

**Not applicable in the form the audit brief assumes**, and this needs to be
stated plainly rather than scored as a defect: the product does not produce
a maintenance calendar, does not track multiple systems at once, and does
not tell a homeowner what to do next season. It produces one repair-or-replace
call for one system, once, per $59. The FAQ says this outright: "Each
report covers one repair-or-replace decision... Deciding on more than one
system at once? Submit a separate report for each." That is an honest scope
statement, not a broken promise — but it means the product does not deliver
the "when should this happen, across my whole house" planning value this
audit's own framework treats as the category's ideal. See Recommended
Product Specification for what closing that gap would require.

---

## Risk Audit

**Safety risks:** handled correctly and unconditionally — see Decision
Engine Audit. This is the one place where the product explicitly refuses to
let cost logic touch the outcome, and it is tested against the least
forgiving case (repair dramatically cheaper) to prove it.

**Property-damage / major-repair risks:** the "already past typical
service life" caution (`navigator-home-maintenance-engine.js:217-221`) is a
real, if modest, early-warning signal — it tells a customer who chose
"repair" that the decision is likely to recur soon. It does not, however,
warn a customer who chooses **replace** about anything (there's nothing to
caution there), and it does not warn about consequential damage risk from
delay (e.g., a leaking water heater causing floor damage) beyond the
symptom checkbox itself.

**Insurance-related risk:** correctly, entirely absent. Neither the page nor
the engine claims an insurance-premium benefit, an insurability benefit, or
any interaction with a policy. This is the right restraint — this audit's
own brief explicitly warns against manufacturing a premium-savings benefit
where the evidence doesn't support one, and this product simply doesn't
try.

**Unnecessary-spending risk (false urgency):** none found. The product's
entire design is oriented against manufactured urgency — it will not
recommend replacement based on age alone (the lifespan table is
"context... never a claim about this specific unit's remaining life," per
the write-up prompt's own hard rule), and it explicitly refuses to render
any financial verdict without the customer's own numbers.

---

## Evidence Audit

| Claim / Recommendation | Evidence | Evidence Type | Recency | Evidence Strength (0–5) | Completeness (0–5) | Decision Confidence (0–5) | Key Uncertainty |
|---|---|---|---|---:|---:|---:|---|
| REPLACE/REPAIR verdict via the 50% ratio | Customer's own two typed quotes | Customer-Specific + Industry (disclosed heuristic) | Current | 5 | 5 (when both quotes given) | 4 | The 50% rule itself ignores financing, efficiency, and warranty differences — disclosed as a simplification, not hidden |
| Age vs. typical service-life range | Curated 5-row table, by category | Industry / Generic | Historical (slow-moving engineering fact) | 3 | 2 (material/type never asked, despite being the caveat's own named variable) | n/a (context only, never a standalone recommendation) | Roof/Water Heater ranges can be nearly 2x off if material differs from the assumed default |
| Contractor question checklist | Fixed reference list per category | Generic (by design — a reference list, not a finding) | Durable | n/a | n/a | n/a | Correctly presented by the write-up prompt as "practical next steps," never as something "discovered" |
| Safety override → urgent guidance | Self-reported symptom checkbox | Customer-Specific | Current | 2 (a checkbox, not a verified hazard) | 5 (sufficient for the *action* it triggers) | 5 | Correctly weighted: low evidence strength is appropriate here because the recommended action (call a professional) is cheap and reversible relative to the downside of a missed real hazard |
| "No financial verdict yet" (missing-quote states) | Absence of customer input | n/a | Current | n/a (a "no action" state, not a claim) | 5 (correctly identifies exactly what's missing) | n/a | Does not yet tell the customer *how* to get the missing figure quickly — a copy gap, not an evidence gap |
| $59 price reflecting "real, computed, decision-grade work" | Cross-product comparison | Comparative | Current | 4 | 5 | 4 | See Pricing Audit — the comparison is strong; the conclusion is a pricing judgment, not a factual one |

**Audit of the evidence system itself:** the engine does not display a
formal 0-5 evidence score to the customer, and it does not need to — its
actual behavior already satisfies the substance of Sections 6, 11, 12, and
14 of this audit's framework without the scaffolding. It shows its work
(the `reasons` array states the exact numbers and threshold used), it
never lets a low-cost, reversible caution require strong evidence
(the safety override triggers on a self-reported checkbox alone, correctly),
and it never lets a "no answer yet" state get filled with a manufactured
one. The one place it falls short of its own standard is the lifespan
table: it states a caveat about material/type variance without ever
asking the one question that would resolve it, which is a data-collection
gap, not a disclosure gap.

---

## Actionability Audit

Every verdict path ends at a specific next action:

| Verdict | What the customer is told to do next |
|---|---|
| `urgent_safety` | Contact a licensed professional now; specific gas-leak instructions (leave the property, call from outside) |
| `replace` | Replace, with the checklist of contractor questions for that category |
| `repair` | Repair, with the checklist, plus a caution if the system is already past its typical range |
| `need_repair_quote` / `need_replacement_quote` | Get the one missing quote — but **does not say how quickly, cheaply, or where to get it**, a real if minor gap |
| `need_both_quotes` | Get both quotes before a financial verdict is possible — same gap |

DIY-vs-professional guidance is present only implicitly, through the
category checklists ("ask a contractor..."); the product does not
distinguish tasks a homeowner could reasonably do themselves from ones that
require a licensed professional, beyond the safety-override case. For the
five named categories (roof, HVAC, water heater, windows, generator), that
is defensible — these are not typically DIY replacement jobs — but it means
the product offers no DIY/professional judgment at all, which the audit
brief calls for as a general capability.

---

## UX Audit (vs. `/closing`)

**Verified live**, both pages loaded and screenshotted this session.
Home Maintenance is visibly the *closest* of the non-`/closing` Navigator
pages to the `/closing` design language — same ink/paper palette, same
Newsreader/IBM Plex fonts, same flat card and button treatment on the
primary pricing card. This was a deliberate reskin (`navigator-closing-theme.css`
is loaded on top of the shared stylesheet), and it mostly works.

**Concrete, confirmed discrepancies:**
- **Header treatment diverges.** Home Maintenance still shows a colored
  logo-mark icon box and a pill-shaped "Home Maintenance Navigator"
  sub-brand badge next to the wordmark. `/closing`'s header is plain text:
  `StreamNavigator / Closing Disclosure Audit`. This exact gap was already
  identified and deliberately left open on `/property-tax` in
  `docs/PROPERTY-TAX-AUDIT.md` as a known, low-priority cosmetic choice —
  it applies identically here, uncorrected.
- **Two unused font families load on every page view.** `home-maintenance.html`
  loads Inter and Sora (the shared theme's fonts) *and* Newsreader/IBM Plex
  (the closing theme's fonts) — four families in one page load, when only
  the second pair is actually used once `navigator-closing-theme.css`
  overrides the shared rules. This is dead network weight with no visual
  benefit, on every visit.
- **Smaller components still carry the old system's visual habits** — chip
  toggles, check-card ticks, and step-number circles keep rounder corners
  and small offset shadows that `/closing`'s hand-written CSS never uses
  anywhere (flat 1px hairline borders throughout). Minor, but visible on
  close inspection.

**Mobile:** verified at 375×812 — the layout holds up well, text remains
legible, the header wraps cleanly to two rows, and nothing overlaps or
clips. No mobile-specific defect found.

**Verdict:** closer to `/closing` than any other Navigator page, but not a
match, and the gap is entirely cosmetic residue from the override-layer
approach rather than a rebuild — the same story property-tax's own audit
already told about itself.

---

## Pricing Audit

**Current Price:** ~~$59~~ **$39, one-time — shipped and live.** The page,
the Stripe Payment Link, and `prices.config.json` all agree on $39; the old
$59 link is deactivated in Stripe.

**Recommended Price:** **$39, one-time.**

**Recommended Pricing Model:** one-time (unchanged) — this is a single,
non-recurring decision. It is not in `ENTITLED_PRODUCTS` (only `rental` and
`landlord` carry a year of re-runs), and there is nothing to monitor or
re-check after the verdict is delivered. A subscription would sell an
ongoing service this product does not render.

**Reasoning.** The house standard, applied twice already in this codebase
(`docs/PROPERTY-TAX-AUDIT.md`, `docs/SUBSCRIPTIONS-AUDIT.md`) is to price by
mechanism shape and real work done, not by the dollar stakes of the
decision the customer happens to be facing. Applying that same standard here,
consistently, against every deterministic-engine product in the line:

| Product | Price | Engine complexity (lines) | Requires a document? | Reference data beyond the customer's own input? | Recurring benefit? |
|---|---:|---:|---|---|---|
| Government Money Finder | $39 | 822 (+ 377-line program table) | No | Yes — a held program-eligibility table | No |
| Contractor Navigator | $49 | 2,163 (+ 373-line reference table) | Yes — an actual contractor estimate | Yes — statutory caps, published cost ranges | No |
| **Home Maintenance Navigator** | **$59** | **285 (smallest in the line)** | **No** | **A 5-row lifespan table only — no cost data at all** | **No** |
| Property Tax Navigator | $79 | 329 | No | No — customer-supplied figures only | Yes — an appeal saves money every year until reassessment (this is `/property-tax`'s own audit's stated reason for costing more than its "mechanically identical twin," Home Maintenance) |
| Insurance / HOA Navigator | $79 each | — | Yes — real uploaded documents, diffed | — | No |

Home Maintenance has the smallest, simplest engine of the four self-serve
products in this table, requires no document, holds no cost-reference data
of any kind (deliberately, and correctly — see Decision Engine Audit), and
confers no recurring benefit. By the same logic `/property-tax`'s own audit
used to justify Property Tax costing *more* than Home Maintenance (a
recurring benefit Home Maintenance doesn't have), Home Maintenance should
cost no more than — and arguably less than — Government Money Finder, its
closest mechanical twin by engine shape, and meaningfully less than
Contractor Navigator, which does substantially more real, checkable work
(document extraction against a statutory reference database) for $10 less
than Home Maintenance charges today.

This was not caught by the earlier `docs/HOME-MAINTENANCE-AUDIT.md` because
that audit predates the cross-product mechanism-shape comparison
`/property-tax`'s later audit established as the house standard — it
confirmed the $59 price stood "on the same terms" (methodology: don't sell
a claim you can't back up) as Insurance and Government Money, but never
actually compared the *number* against those products' engine complexity.
Doing that comparison now surfaces a real, if modest, inconsistency.

**Customer Value Threshold (Section 20):** for a customer who already has
both quotes in hand, the product's marginal value over free public
information (the 50% repair-vs-replace rule is a widely published,
commonly-cited personal-finance heuristic) is real but modest — consistent
threshold application, service-life framing, and a checklist. That is
worth something. It is not, on its own mechanical merits, worth more than a
product that extracts and cross-checks a real contract against statutory
law.

---

## Required Changes

*(All eight items below shipped 2026-09-20, same day as this report. See the
Status note at the top of this document for the one piece — the live Stripe
Payment Link — that still needs a human with Stripe credentials.)*

### Critical — Must Fix

*(None remaining — both shipped.)*

1. ~~Add a thin-result auto-refund for `NEED_BOTH_QUOTES`.~~ **Shipped.**
   `api/_lib/navigator-engine.js` now sets `refund_state: 'due_thin_result'`
   the moment `homeMaintenanceAnalysis.verdict === Verdict.NEED_BOTH_QUOTES`,
   picked up by `api/process-refunds.js`'s existing `REFUND_STATE_THIN` queue
   — the same mechanism Government Money Finder and Contractor Navigator
   already use for the identical shape of problem. The page's field hint and
   FAQ both now disclose this before payment. Covered by
   `tests/home-maintenance-page.test.js`.
2. ~~Fix the silent category default.~~ **Shipped.** `home-maintenance.html`'s
   inline script now starts `selectedCategory` at `null`; a customer who
   never clicks a category chip is blocked by `checkSufficiency()` instead of
   silently defaulting to Roof. Verified live in this session (no chip shows
   active on load) and pinned by `tests/home-maintenance-page.test.js`.

### High Priority

*(Both shipped, end to end.)*

3. ~~Cut the price to $39, one-time.~~ **Shipped.** A new $39.00 one-time
   price was added to the existing "Home Maintenance Navigator Report"
   Stripe product and set as its default; a Payment Link for it
   (`buy.stripe.com/eVqfZh2W0diI4W80xqabK0l`) was created with the same
   after-payment redirect as every other Navigator product
   (`/navigator-status`); the old $59 link
   (`buy.stripe.com/28EeVd9ko3I80FS1BuabK09`) is deactivated, not deleted.
   `scripts/set-home-maintenance-link.js` wired the new URL into
   `home-maintenance.html` and moved `prices.config.json`'s entry for this
   page back from `_skipped` into `pages` at 3900 cents. `npm run
   check-prices` confirms the page, the config, and the button all agree.
4. ~~Ask the material/type question for Roof and Water Heater~~ — **Shipped.**
   `navigator-home-maintenance-engine.js` now holds a `MATERIAL_RANGES` table
   for both categories (metal/tile/slate roofing, tankless water heaters),
   additive to the existing default table so every prior test still passes
   unchanged. The page renders the material chips only for these two
   categories, reading the options from the engine so the two can't drift
   apart. Covered by new tests in `tests/home-maintenance-engine.test.js`.

### Medium Priority

*(Both shipped.)*

5. ~~Tell the customer how to get a missing quote quickly~~ — **Shipped.**
   The write-up prompt (`api/_lib/navigator-engine.js`) now instructs the
   model to point a missing-quote customer at the checklist's own
   "get another quote" reminder as the concrete next step, rather than only
   naming what's absent.
6. ~~Ask whether the system has already been repaired before for the same
   issue.~~ **Shipped.** A new checkbox feeds `already_repaired_before` into
   the engine, which adds a disclosed caution on a `repair` verdict without
   ever changing the verdict itself — additive, exactly like the existing
   age-based caution. Covered by new tests in
   `tests/home-maintenance-engine.test.js`.

### Low Priority

*(Both shipped.)*

7. ~~Drop the colored logo-mark icon and pill sub-brand badge from the
   header~~ — **Shipped**, on `home-maintenance.html` (the `/property-tax`
   instance of this same gap is unchanged and remains open there).
8. ~~Remove the unused Inter/Sora `<link>` tags~~ — **Shipped.**

---

## Recommended Product Specification

**What Home Maintenance Navigator does today, correctly, and should keep
doing:** one repair-or-replace decision, arithmetic only on the customer's
own two quotes, an unconditional safety override, a disclosed threshold, and
a refusal to guess a cost it doesn't have. Do not weaken any of this to
build the expansion below — it is the product's actual credibility.

**The natural next-tier product, if StreamNavigator wants to capture the
fuller "which maintenance is worth doing, house-wide, and when" value this
audit's brief describes as the category's ideal**, without touching the
existing $39 single-decision product:

- **Inputs:** a one-time system inventory per property — category + age for
  each major system the homeowner has (roof, HVAC, water heater, windows,
  generator, plus water/electrical/plumbing basics) — reusing the exact
  `CATEGORIES`/`LIFESPAN_RANGES` vocabulary already built for this product.
- **Calculation:** for each system, where it sits against its typical
  service-life range (same deterministic table, no new cost claims) —
  producing a **prioritized list by proximity to end-of-typical-life**, not
  by invented dollar risk. Systems past their range are flagged for budget
  planning; systems well within range are explicitly told "nothing to do
  yet," consistent with this audit's Section 20 standard that a genuine "do
  nothing" answer is a valuable, not a wasted, output.
- **Output:** a household maintenance-timing calendar — what to start
  budgeting for and roughly when — explicitly **not** a cost estimate (the
  same discipline this product already holds), paired with an offer to run
  the existing $39 repair-vs-replace report the moment any specific system
  actually needs a decision.
- **Pricing:** this is a materially larger, recurring-relevant product (a
  household's system inventory is worth re-checking annually) and could
  reasonably justify an annual price along the lines of Insurance/HOA ($79),
  or a modest add-on to an existing Navigator bundle — but this is a new
  product decision requiring its own audit before a number is set, not an
  extension of today's $39 recommendation.

This is explicitly a **future opportunity**, not a required fix — the
current product is honest about not doing this, and should not be marked
down for a scope it never promised.

---

## Final Customer-Value Test

> **If I were a rational homeowner paying the recommended price, would I
> reasonably expect this product to save me more money than it costs by
> helping me spend money on the right maintenance at the right time while
> avoiding unnecessary maintenance spending and preventable expensive
> problems?**

### Customer Value Assessment

**At $39, yes, for the customer who has both quotes in hand** — which the
product's own field hint tells them to get before paying, and which is the
condition under which the engine delivers its actual, computed,
non-generic answer. The disclosed 50% threshold, applied consistently and
shown in the customer's own numbers, is worth more than the ten seconds it
takes to compute, because it comes bundled with the service-life context,
the safety triage, and the negotiation checklist — genuine, if modest,
value beyond doing the division yourself.

**At $59 today, and for the customer without quotes yet, no** — not until
Critical fix #1 ships. A customer who honestly discloses they have no
quotes, exactly as the product invites them to, currently pays full price
for a category checklist and a boilerplate sentence. That customer should
either not have been charged, or should get their money back automatically,
the way two sibling products in this same codebase already handle the
identical situation.

### Recommended Product

Keep the deterministic engine, the safety override, and the refusal to
invent a cost exactly as they are. Fix the silent category default. Add the
missing thin-result refund. Ask one more question (material/type) to
sharpen the one piece of non-customer-supplied content in the report.

### Recommended Price

**$39, one-time.**

### Highest-Impact Fix

**The thin-result refund (Critical #1).** Every other issue in this report
is a matter of degree — a price that's somewhat high, a design detail
that's somewhat inconsistent, a question that could sharpen a range. This
one is categorical: it is the difference between a product that keeps its
core promise ("never a guess at what either one usually costs — and never
a charge without an answer") and one that quietly breaks it for a disclosed,
tested, intentionally-supported subset of its own paying customers.
