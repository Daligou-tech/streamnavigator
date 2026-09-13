# Contractor Navigator — product audit, 2026-09-13

What `/contractor` promised, what it did, and what was changed. Written after the
rebuild rather than before it, so everything below is either fixed or recorded as
still open.

---

## 1. The promise

A homeowner is about to spend five figures on HVAC, roofing, windows, plumbing or
electrical work. The page offered a second opinion on the estimate before they
sign, for $49, delivered in minutes:

- Is the price reasonable for this category and scope?
- Are competing quotes apples-to-apples?
- What is missing from the estimate?
- What could become a costly change order?
- What should they ask, and what is worth negotiating?
- Which quote is strongest?
- A ready-to-send email to the contractor.

Step 5 of "how it works" said: *"AI researches the context — typical price ranges
and what's normal for this category are factored in."*

The real customer value proposition is narrower and better than the copy: a
homeowner has no idea what is normal, is often under active sales pressure, and
is holding a document whose important parts are the ones they do not know to look
for. They are not buying a price opinion. They are buying the thing a friend in
the trade would tell them in ten minutes.

## 2. What it actually did

One Anthropic call. Documents in, verdict out, `max_tokens: 4096`. It was the
last engine in the catalogue still built that way — closing, rental and HOA had
all moved to extract-then-check-then-write months earlier.

**Nothing researched anything.** There was no price data, no rate table, no
search. Every "the price looks high" was model recall, unnamed, uncited, and
different run to run. Step 5 described work that did not exist.

**Nothing added anything up.** An estimate whose line items total $9,340 against
a printed contract price of $9,840 went out as a clean report. Arithmetic is not
what catches a reader's eye, and nothing was working through a list.

**The findings that matter most were unreachable.** A deposit over a state's
statutory cap, a split system below the federal efficiency minimum for that
state, a price justified by the 25C tax credit that ended on 31 December 2025 —
none of that is in the document, so a model reading only the document could not
have found it however carefully it looked.

**The form collected almost nothing.** Category (silently defaulted to HVAC by
JavaScript while no chip rendered as selected, so a roofer who never touched the
row had their roof quote analysed as HVAC), an optional description, files,
email. The engine read `formData.zip`; the form never collected it. The one field
that could have placed a price regionally was dead on both sides.

**Paid and silent.** Generation ran only inside the customer's browser poll.
Pay, see the Stripe receipt, close the tab, and the row sat at `paid` with
nothing scheduled to look at it again — no report, no email, no refund, because
`api/process-refunds.js` only considers rows that reached `failed`.
`tests/no-orphaned-paid.test.js` recorded the gap and left it open on the grounds
that the product had taken zero payments.

**No delivery.** No email, no PDF, no link that worked on a second device.
`localStorage` in the purchasing browser was the only route back to a paid
report. `api/_lib/report-delivery.js` read `navigator_reports`; contractor writes
to `contractor_reports`.

**Stale refund copy.** The engine had been given an automatic refund on failure
three days earlier, but `navigator-status.html` still excluded contractor from
`AUTO_REFUNDED` and told those customers to write in.

## 3. What changed

### The engine

Three stages, mirroring `closing-audit.js` and `rental-audit.js`:

| File | Job |
|---|---|
| `api/_lib/contractor-extract.js` | Reads estimates into structured figures. Judges nothing, computes nothing. |
| `api/_lib/contractor-reference.js` | Everything not in the customer's documents: statutes, federal standards, published price bands. Every entry sourced. |
| `api/_lib/contractor-audit.js` | 38 named checks over those figures. No model runs in this file. |
| `api/_lib/contractor-emails.js` | The negotiation email, built deterministically. No model touches it. |
| `api/_lib/contractor-engine.js` | Orchestrates, then hands a model the **findings** — never the documents — to write the opening. |

26 checks run on any estimate; HVAC adds 6 (32 total), roofing 3 (29), windows
2 (28). Plumbing and electrical run the 26, and the page says so rather than
implying a trade-specific set exists.

### What the reference data actually holds

- Statutory deposit caps for CA, NV, MD, MA and PA, each with its citation; NY's
  escrow requirement separately; customary practice, labelled as such, everywhere
  else.
- DOE regional minimum SEER2 by state (13.4 North / 14.3 South and Southwest).
- The R-410A end of manufacture (1 Jan 2025) — reported as an outgoing platform
  and a negotiating position, **not** as a violation, because installing
  remaining stock was never prohibited.
- 26 U.S.C. § 25C, terminated for property placed in service after 31 Dec 2025.
  A quote still selling that credit is a finding worth the price of the report.
- Contractor licensing boards for 22 states, with a generic fallback.
- Published national installed-cost bands per unit (per ton, per roofing square,
  per window, per panel, per water heater), each with its source and its caveat.

### Restraint, enforced by tests

The three sentences a homeowner repeats to a contractor's face, and which the old
engine could produce on any run:

- A published national range is **never** presented as proof of overcharging. Its
  distance from the band is typed `above_published_range` and is excluded from
  every "money in dispute" total. Inside the band is reported as *not proof of a
  good price*.
- A statutory cap is **never** applied in a state without a statute.
- The federal three-day cancellation right is **never** asserted for a sale it
  does not cover. An unanswered intake question skips the check by name rather
  than guessing.

### Coverage, and an automatic refund

Every report says how many checks ran out of how many apply, and names each one
that could not with the reason. Below 60%, the customer keeps the report and the
$49 goes back without them asking — `refund_state: 'due_thin_result'`, picked up
by a second queue in `api/process-refunds.js`.

### Operational holes closed

- `api/generate-paid-navigator.js` now sweeps contractor, looking its generator
  up per product rather than assuming the generic engine.
- `api/_lib/report-delivery.js` reads `contractor_reports` and converts the
  report through `api/_lib/contractor-report-view.js` into the shape the PDF
  builder understands.
- `api/process-refunds.js` guard 4 now looks in **both** report tables. Without
  that, adding contractor to the refund path would have refunded delivered
  reports.
- `navigator-status.html` tells a failed contractor customer the truth about
  their refund.
- `tests/no-orphaned-paid.test.js` has no exemptions left.

### The form

Trade (nothing pre-selected), state (required), *were you quoted at your home?*
(required), files, optional home size, optional description, email. Every one of
those answers switches a check on, and `tests/contractor-claims.test.js` fails if
the form asks for something no check consumes.

### Design

`navigator-editorial.css` is the `/closing` style block, lifted verbatim.
`tests/contractor-design.test.js` compares it against `closing.html` character
for character, so a palette change on `/closing` fails the build until the copy
is refreshed. Both contractor pages link it and load Newsreader / IBM Plex Sans /
IBM Plex Mono; neither redefines a token or hardcodes a hex value.

## 4. Price

**Kept at $49.** Considered raising it to $59 to match the Closing audit, whose
29 checks are comparable work, and decided against.

The argument for $49 is the one that matters: `/closing` charges $59 *after*
showing the customer a free scorecard of what it found. `/contractor` charges
before showing anything. A blind purchase should cost less than an informed one,
and the automatic refund below 60% coverage is what stands in for the scorecard —
it means a customer whose documents are too thin pays nothing rather than paying
for a report that is mostly a checklist.

Against the value delivered, $49 is comfortably cheap: a single deposit over a
statutory cap on a $15,000 job is $3,000 held back, and the nearest paid
alternative (an owner's rep or a construction consultant reviewing a bid) is
$200–$500. It stays at $49 because the customer's position — mid-decision, often
under sales pressure, with no free preview — is the wrong place to add friction,
not because $49 is all it is worth.

The page also now tells people **not** to buy it when the job is under about
$2,000. The findings scale with the job — a deposit cap on a $900 water heater
is worth a few hundred dollars at most — and telling someone to go and get a
second quote instead is worth more to them than the report would be. That
sentence costs sales and it is the correct sentence.

## 5. Still open

- **No free scorecard.** `/closing` shows findings before payment. That is the
  strongest trust mechanism in the catalogue and contractor does not have it. The
  coverage refund substitutes for it; it does not replace it.
- **Plumbing and electrical have no trade-specific checks.** Honest today (the
  work is too varied for one set), but water heaters and panel upgrades are
  common enough that a sub-category with its own checks would be worth it.
- **No local pricing.** The bands are national and say so. Real local comps would
  need a data source this product does not have, and inventing one would undo the
  main thing this rebuild fixed.
- **The extraction is the remaining single point of failure.** Everything
  downstream is deterministic and tested; if a report looks wrong and
  `npm run contractor-harness` looks right, the extraction is where to look.
