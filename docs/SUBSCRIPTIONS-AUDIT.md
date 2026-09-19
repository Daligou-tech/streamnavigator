# Subscription Navigator Audit

An evaluation of `/subscriptions` — the page, the intake, the engine behind it,
and whether a customer who pays $49 gets more than $49 back.

Conducted 2026-09-19 against production (streamnavigator.ai/subscriptions) and
against `subscriptions.html`, `api/navigator-intake.js`, and
`api/_lib/navigator-engine.js` at `90e73b8`. No paid model runs were spent: the
findings below rest on the live page, two live intake calls that cost nothing,
and the code. `/closing` is used throughout as the standard, because it is the
same company's answer to the same problem and it is a much better one.

---

## A. Executive conclusion

**No. `/subscriptions` does not deliver on its promise, and the reason is
structural rather than cosmetic.**

The page promises a keep/cancel/rotate/downgrade call on every subscription.
The intake collects one free-text box, an optional statement, and an email. It
never asks the price, the billing period, the renewal date, when the service
was last used, who else in the household uses it, or whether the customer would
miss it. Those six facts are the entire basis on which any of the four
recommendations can be made. None of them is collected.

What sits behind the box is not an engine. It is a five-sentence prompt inside
`PRODUCT_CONFIGS['subscriptions']` (`api/_lib/navigator-engine.js:254`) handed
to `claude-sonnet-5` with the generic eleven-product report schema. There is no
catalog, no price table, no pause-policy table, no arithmetic, and no check that
runs. Compare `api/_lib/closing-audit.js` (28 named deterministic checks) or
`navigator-streaming-engine.js` (dated recommendations from a verified price
catalog). `/subscriptions` has neither, and it is the more expensive product.

Three specific consequences, each verified rather than inferred:

1. **A single letter buys a report.** `/subscriptions` has no sufficiency gate.
   Posting `{product:'subscriptions', description:'a'}` to the live intake
   returned `200 ok` and a submission id (`4d40f401-35be-4b86-ba6a-3978fcff11bb`),
   ready for a $49 checkout. The identical call to `/buying` returns `400` with
   a list of what is missing. This is the same D-04 / buying-sufficiency defect
   that was found and fixed twice already; it was never fixed here.
2. **The page sells a deliverable the engine is instructed not to produce.**
   "Direct links to cancel or downgrade where available" appears twice on the
   page. The prompt says: *"describe it in general terms rather than fabricating
   a specific URL."* The repo holds exactly one set of real cancellation URLs —
   `MANAGE_URLS` in `navigator-streaming-engine.js`, 20 streaming services — and
   `navigator-engine.js` does not import it. So the customer is sold links that
   either do not arrive or arrive invented. This is the class of defect
   `tests/navigator-claims.test.js` was written to catch on `/landlord`; the
   test does not cover it.
3. **The restart half of the promise is unreachable.** The page sells "rotate
   (pause and resume)" and the hero promises to tell you when to start again.
   The only question the form asks is *"What are you subscribed to?"* — and a
   subscription you should restart is by definition one you are not subscribed
   to. There is no field for it. Half the proposition has no input path.

Separately: `/home-savings` sells the same four verbs ("cancel, downgrade,
switch, or renegotiate") over "utilities, internet, phone, insurance,
**memberships, subscriptions**" at the **same $49**. It is a strict superset.
A customer comparing the two has no reason to pick this one.

And `/streaming` — $19.99/year — does for streaming what `/subscriptions`
claims to do for everything, but properly: verified prices, real cancel links, a
`canPause` flag per service, a sports calendar, promo-rate and bundle warnings,
household-viewer warnings, and a restart **date**. It is a better product at
40% of the price. The $49 page cannot survive that comparison on the same site.

**Bottom line: the discovery problem (what am I paying for?) is largely solved
by a bank statement, for free. The decision problem (which of these is safe to
kill, and when do I turn it back on?) is real, valuable and unsolved — and this
page does not attempt it, because it does not collect the inputs.**

---

## B. Customer-value scorecard

Rated only where a rating carries information.

| Dimension | Verdict |
|---|---|
| Value proposition | **Weak as stated.** "Optimize every subscription" is not a benefit. The real benefit — a safe, dated decision per line — is never claimed because the product cannot deliver it. |
| Ease of use | **High, and that is the problem.** One box, one email. The friction is zero because nothing useful is being asked. |
| Input process | **Fails.** Six determinative facts, none collected. No gate. Verified live. |
| Decision engine | **Does not exist.** A five-sentence prompt, no checks, no catalog, no arithmetic. |
| Recommendation quality | **Cannot be relied on.** Not because the model reasons badly, but because on 6 of the 13 scenarios in section D the fact that decides the answer is never on the page. Three of those six lose the customer money or data. |
| Output | **Generic prose.** Shared eleven-product schema. No per-subscription row, no cost-per-use, no dates, no confidence, no "what we could not decide". |
| Savings potential | **Real — $150–$700/yr identified for a typical household** (section H). Which is what makes the current build worth fixing rather than deleting. |
| Trust | **Underbuilt.** The one genuinely strong claim — no bank login, ever — is buried in FAQ #2. No retention statement on the page, no "what this does not do", no refund guarantee. `/closing` has all four. |
| Pricing | **Too high for what ships.** $49 for unstructured prose, against a free statement, a $49 sibling that does more, and a $19.99/yr sibling that does it better. |
| Visual design | **Wrong template.** Uses `navigator-shared.css` (gradient/SaaS) where `/closing` uses `navigator-editorial.css`, which already exists in the repo and is already adopted by `/contractor`. |
| Overall customer value | **Net negative risk today.** A customer acting on an unqualified "cancel" against a prepaid annual plan, a bundled account, or a cloud-storage subscription is worse off than if they had done nothing. |

---

## C. Major problems

### Critical

**C1. No sufficiency gate — a one-character submission reaches a $49 checkout.**
`api/navigator-intake.js:138-148`. Verified live. `/buying` and `/landlord` both
have structured gates; `/subscriptions` falls through to the generic D-04 check,
which only requires the description to be non-empty.

**C2. The intake collects none of the six facts that decide the recommendation.**
Price, billing period, renewal date, last used, household users, and "would you
miss it". The placeholder text — *"e.g. Spotify, Adobe CC, gym, meal kit, cloud
storage, streaming services..."* — models a name-only list, i.e. the page's own
example input is insufficient for the page's own promise.

**C3. A "cancel" on a prepaid annual plan costs the customer money.** Nothing in
the form asks whether a subscription is annual or when it renews.
`navigator-streaming-engine.js:356` already handles this correctly for streaming
("Don't cancel — it's an annual plan"). The $49 product has no such guard. Adobe
CC, Microsoft 365, and most gym contracts are the live cases.

**C4. A "cancel" on cloud storage or a bundled account destroys value that is not
money.** iCloud/Google One cancellation deletes data above the free tier; Prime
cancellation drops delivery. The streaming engine carries an explicit
`bundle-benefits` caution for exactly this. The subscriptions prompt carries
none.

**C5. The page sells cancellation links the engine is told not to invent.**
Twice in the body copy. See section A.2.

### High

**H1. Restart/rotate has no input path.** See section A.3. Either build the
field or stop selling the verb.

**H2. No promotional / legacy-rate field.** Cancelling a $4 legacy NYT rate or a
grandfathered plan is frequently a permanent loss that dwarfs the saving. The
streaming engine has an `isPromoRate` caution. This one does not.

**H3. No household field.** One person cannot cancel a family plan on their own
say-so. The streaming engine warns on multiple viewers. This one cannot.

**H4. No free preview.** `/closing` shows a free scorecard before asking for
money — which is both the conversion mechanism and the honesty mechanism. Here
the customer pays first and finds out afterwards whether there was anything to
find.

**H5. No refund position.** `/closing`: "If the report misses what it promised,
we refund in full." `/terms`: non-refundable once generated. For a product whose
output quality is this unpredictable, that asymmetry is the wrong way round.

**H6. Savings totals have no accounting discipline.** `api/_lib/rental-audit.js`
enforces impact kinds — recoverable vs excess vs exposure — and forbids totalling
across them. Nothing stops this product adding a speculative rotate saving, a
promo-rate saving that will not survive a round trip, and a confirmed
cancellation into one headline number.

**H7. Duplicate product at the same price.** `/home-savings`, $49, explicitly
covers memberships and subscriptions.

**H8. No retention or privacy statement on the page.** The customer is invited to
upload a bank statement. `/closing` states in the intake card that copies sent
for analysis are deleted immediately and uploads are held 90 days encrypted. The
same is true here (`privacy-policy.html:118`) and the page does not say so.

### Medium

**M1. Design identity is the wrong one** (section I).

**M2. No "What this does not do" section.** `/closing` has one, and it is a trust
asset, not a liability.

**M3. Nothing tells the customer what the report costs them in effort afterwards.**
Cancelling 6 things takes an hour and several phone calls. Saying so raises
trust and reduces refund requests.

**M4. The `category-chip` handler in the page script binds to elements that do
not exist.** `subscriptions.html` wires `.category-chip` listeners; the page has
no chips. `selectedCategory` is always `null` and is posted as such. Dead code.

**M5. Two orphan test submissions** were created during this audit
(`427d20f6-…`, `4d40f401-…`, email `audit-test@example.com`). Unpaid, so they
will never generate. Worth a sweep.

### Low

**L1. The hero pill, the H1 gradient and the emoji footer nav** all read as 2021
SaaS template and undercut a $49 price.

**L2. FAQ #2 holds the strongest sales point on the page** ("No bank login is
ever required") in the least-read position.

**L3. `charged once · not a subscription`** is good copy doing good work. Keep it.

---

## D. Thirteen household scenarios, and what the product does with them

The column that matters is the last one. In six of thirteen cases **the fact
that decides the answer is never collected by the form**, so a correct
recommendation is available only by luck. This is not a claim about how the
model reasons — it is a claim about what the model is given.

| # | Scenario | Correct call | Fact that decides it | Collected today? |
|---|---|---|---|---|
| 1 | Netflix $19.99/mo, watched this week, two viewers, would miss a lot | KEEP | recent use | no — but the answer is safe anyway |
| 2 | Hulu $18.99/mo, not opened in 4 months, nobody else, would not miss | CANCEL, $227.88/yr | last used | no |
| 3 | Peacock $7.99/mo, Premier League only (Aug–May) | ROTATE off Jun–Jul, restart ~15 Aug, **saves $15.98 — two cycles, not $95.88** | seasonality + cycle arithmetic | no |
| 4 | Adobe CC $59.99/mo **annual, prepaid in March**, used twice | KEEP UNTIL 14 March, $0 today | billing period + renewal date | **no — and "cancel" here costs real money** |
| 5 | Spotify Duo $16.99/mo, partner uses it daily, customer barely does | REVIEW — ask them | who else uses it | **no — a unilateral cancel is possible** |
| 6 | Amazon Prime $14.99/mo, video unwatched, delivery used weekly | REVIEW — cancelling video cancels delivery | bundling | **no** |
| 7 | Gym $39/mo, not been since January, annual contract | CANCEL, but name the written-notice step — do not promise $468 | contract term | no |
| 8 | iCloud 2TB $9.99/mo, "barely used", holds the photo library | REVIEW — export first; cancelling deletes data | data at stake | **no — "barely used" points straight at cancel** |
| 9 | NYT $4/mo on a legacy rate, read twice a month | KEEP — $4 will not come back | promo/legacy rate | **no** |
| 10 | Disney+ **cancelled in March**, customer now has a 4-year-old | RESTART | a service you are not paying for | **no — no input path exists at all** |
| 11 | Max + Paramount+ + Hulu, ~4h/week total across the household | Keep one, rotate two — which depends on what they watch | what they actually watch | no |
| 12 | Weather app $2.99/mo, never opened | CANCEL, $35.88/yr — but do not lead the report with it | price floor + ordering | no |
| 13 | Microsoft 365 $99/yr, used twice, only thing that opens work .docx | DOWNGRADE to free web Office, naming the tradeoff — not CANCEL | why they have it | no |

Cases 4, 6 and 8 are the serious ones: in each, the obvious read of the only
information the form collects ("barely used", "unwatched", "used twice") points
at the recommendation that makes the customer worse off. Cases 5, 9 and 10 waste
money or silently drop half the product.

Case 3 also shows the arithmetic failure mode that has no guard: the honest
saving on a two-month rotation is two billing cycles, and there is nothing in
the current pipeline that stops a full-year figure being printed instead.

---

## E. Recommended product logic

### E.1 Minimum sufficient input

Per subscription: one name, one price, and **three taps**. Anything more is
friction; anything less cannot decide.

| Field | Required | Why it decides something |
|---|---|---|
| Name | yes | identity |
| Price + period (monthly/annual) | yes | no price, no saving — and no arithmetic |
| Next renewal date | if annual | a prepaid annual plan must never be told to cancel mid-term |
| Last used | yes — one tap: this week / this month / 2–3 months / 6+ months / never | the usage axis |
| Would you miss it? | yes — one tap: not at all / a bit / a lot | **the single highest-value field, and the only one no bank statement contains** |
| Who uses it | yes — one tap: just me / someone else too | blocks a unilateral cancel on a shared plan |
| Seasonal or event-bound? | optional: "only need it for X", plus when | turns a cancel into a dated rotate |
| On a promo or old rate? | optional checkbox | blocks a cancel that cannot be undone at the same price |
| Bundled with / needed for something else? | optional | blocks a cancel that takes something else with it |

Statement upload stays, and does one job well: it **fills in name, price and
period automatically**, so the customer only supplies the three taps. That is
the correct division of labour — the statement knows the money, only the
customer knows the value.

### E.2 The five outputs

Three is not enough. The product needs five, and the distinction between two of
them is where the money actually is.

- **KEEP** — you are getting what you pay for.
- **DOWNGRADE** — you want it, you do not want this tier.
- **ROTATE** — pause now, restart on a named date. **Only valid where the service
  genuinely offers a hold.**
- **CANCEL** — stop paying, accept that coming back means signing up again at
  whatever the price then is.
- **REVIEW** — one fact is missing, or the decision is not this product's to make
  (shared plan, bundled account, data loss). Naming this honestly is a feature.

**Collapsing ROTATE and CANCEL is the specific way this product loses a customer
money.** Most services do not pause. Telling someone on a legacy rate to "rotate"
Hulu means cancelling it and returning at list price.
`navigator-streaming-engine.js` already carries `canPause` per service for
exactly this reason and already writes the two sentences differently. That table
needs to exist for non-streaming services too, or the verb must not be used on
them.

### E.3 Decision rules, in priority order — first match wins

```
 1. Annual plan, prepaid, not at renewal
       -> KEEP UNTIL <renewal date>. Saving = $0 today.
          "Decide on <date>, not now. Cancelling mid-term refunds nothing."
 2. Bundled with / required by something else
       -> REVIEW. Name what else goes with it. Never cancel in isolation.
 3. Cancelling destroys data, history, or accrued value (storage, photos,
    loyalty, medical, tax records)
       -> REVIEW. Name what is lost. Give the export step first.
 4. Someone else in the household uses it
       -> REVIEW / "ask <them> first". Never a unilateral CANCEL.
 5. Promotional or legacy rate below current list
       -> downgrade any CANCEL to REVIEW, with: "you will not get this price
          back." Never ROTATE.
 6. Used this week or this month AND would miss it a lot
       -> KEEP.
 7. Would miss it, used rarely, cheaper tier exists
       -> DOWNGRADE. Saving = (current - cheaper) x 12. Name what is given up.
 8. Not used 3+ months AND would not miss it AND rules 1-5 clear
       -> CANCEL. Saving = price x 12 (monthly) or price (annual).
 9. Would miss it, but need is seasonal or event-dated
       -> canPause  -> ROTATE, restart <date>, saving = cycles skipped x price
          !canPause -> CANCEL AND RETURN ON <date>, same arithmetic, different
                       warning: you re-sign at the price then current.
10. Price under $5/mo AND would miss it at all
       -> KEEP, stated plainly: "this is $36 a year and you like it.
          Not worth the phone call."
11. Price unknown
       -> REVIEW: "tell us what this costs and we will decide it."
          Never estimate a price and then bill a recommendation to it.
```

Rule 10 is the integrity rule. A product that manufactures a big savings total
by recommending eight cancellations the customer will regret is worse than
useless, and it is the default failure mode of any engine graded on the size of
its headline number.

### E.4 Savings accounting

Borrowed in spirit from `api/_lib/rental-audit.js`, which already enforces this
discipline on a $149 product:

- **Confirmed** — price known, CANCEL or DOWNGRADE, no offsetting cost. Counts.
- **Conditional** — ROTATE. Counts **only the cycles actually skipped**, shown as
  `cycles x price`, never the full annual.
- **At risk** — anything touching a promo rate or bundle. **Never counted in the
  total.** Shown separately.
- **Unpriced** — REVIEW lines. Never counted, never estimated.

One headline number, of one kind, and it is the confirmed one. Everything else is
shown beside it with its own label. Never total across kinds.

---

## F. Recommended customer experience

1. **Land.** Headline states the problem, not the category. One line on what you
   do and one on what you get back.
2. **List.** Paste a list, or drag a statement. The statement fills in name,
   price and period; the paste path asks for them.
3. **Three taps per line.** Last used / would you miss it / who uses it. About
   15 seconds each. Ten subscriptions is under three minutes.
4. **Free scorecard — before any payment.** Deterministic, so it costs nothing to
   run: *"11 subscriptions, $104.91/month. 3 look cancellable — $312/yr. 2 need
   a decision you have to make, not us. 1 we cannot price until you tell us what
   it costs."* No per-line answers, no dates, no links. Exactly the `/closing`
   pattern, which exists to let the customer see the work before paying for it.
5. **Decide.** Buy the report, or do not. If the scorecard found nothing, the
   customer is told so for free — and that is a reputational asset, not a lost
   sale.
6. **Receive.** One row per subscription, every one, ordered by dollars at stake.
7. **Act.** Each row ends in a step to take today, with a date where the date
   matters.
8. **Come back.** The rotate rows carry restart dates. That is the one part of
   this product with legitimate recurring value — and it is exactly what
   `/streaming` already sells for $19.99/yr.

---

## G. Recommended output

A ledger, in `/closing`'s register — one row per subscription, none omitted.

```
YOUR SUBSCRIPTIONS                     11 lines · $104.91/mo · $1,258.92/yr

CONFIRMED SAVINGS  $312.00/yr     AT RISK (not counted)  $48.00/yr
NEEDS YOUR DECISION  3 lines      COULD NOT PRICE  1 line
```

```
CANCEL   Hulu                                        $18.99/mo -> $0
You last opened it 4 months ago and said you would not miss it. Nobody
else in the house uses it.
Saves $227.88 a year, confirmed.
Hulu has no pause. This is a cancellation: you keep access to the end of
the period you have already paid for, and coming back means signing up
again at whatever the price is then.
Do this: cancel from Account > Manage plan before your next charge.

ROTATE   Peacock                                     off Jun-Jul, back 15 Aug
You said you only use it for Premier League. The season runs Aug-May.
Saves $15.98 — two monthly cycles, not the full year.
Two cycles is the honest figure. If switching it off and on twice is not
worth $16 to you, keep it. We would not blame you.
Restart on: 15 August (approximate — season dates move by a week or so)

KEEP UNTIL 14 MARCH   Adobe Creative Cloud           $59.99/mo, annual, prepaid
You have used it twice. On the numbers this looks like the worst line on
the page — and cancelling it today would still be a mistake.
Saves $0 today. This is an annual plan you have already paid for, and
Adobe charges an early-termination fee on top of refunding nothing.
Do this: set a reminder for 1 March and decide then. That decision is
worth $719.88 a year. Today's is worth nothing.

REVIEW   iCloud 2TB                                  $9.99/mo
You said you barely use it. We are not going to tell you to cancel it.
Cancelling paid storage does not just stop a charge — above the free 5GB
Apple begins deleting what does not fit, and on most accounts that is the
photo library.
Do this first: check what is actually in it. If it is 40GB of photos you
want, this is a $120/yr bill for keeping them, and that is a fair price.
If it is a 2018 backup, export it and then cancel.

REVIEW   Spotify Duo                                 $16.99/mo
You barely use it. Your partner uses it daily.
Not a $203.88 saving. Not your call alone.
Do this: ask them. If they want it, this line is settled and it is a keep.

KEEP     NYT Digital                                 $4.00/mo
You read it twice a month and said you would miss it a bit. That is $2 a
read on a rate well below what the NYT charges now.
Cancel this and you will not get $4 back. Keep it.

COULD NOT PRICE   Gym
You did not tell us what this costs, so we have not decided it. You said
you have not been since January and would not miss it — which points one
way, and we will say so once we have the number.
Do this: check your statement for the amount, then re-run this line free.
```

Closing block, always:

```
WHAT WE DID NOT DO
- We did not look at your accounts. Everything above came from what you
  told us and the statement you uploaded.
- We do not know what any of these will cost if you come back. Prices rise.
- Three of these are decisions only you can make. We have said which and why.
- Cancelling six things will take you about an hour. Two will want a phone
  call. Start with Hulu: it is the largest number and the easiest one.
```

Every element of that is checkable against something the customer typed.
Nothing in it requires a fact the product does not hold.

---

## H. Pricing recommendation

**Current:** $49, one-time (`prices.config.json`, Stripe `4gMaEXbsw2E49co5RKabK07`).

**Verdict: too high for what ships, and mispriced against its own siblings even
after a rebuild.**

### Savings scenarios

Assumptions, stated: US household with 8–18 recurring subscriptions; "identified"
is what a competent engine would flag; "realized" applies a 60% action rate,
because people do not cancel everything they are told to.

| | Subs | Monthly spend | Identified /yr | Realized /yr | vs $49 | vs $29 |
|---|---|---|---|---|---|---|
| Low | 6 | ~$55 | $120 | $72 | 1.5x | 2.5x |
| Typical | 11 | ~$105 | $500 | $300 | 6x | 10x |
| High | 18 | ~$190 | $850 | $510 | 10x | 18x |

The typical case clears a fair multiple. The low case does not clear $49 at a
believable action rate — and the low-savings customer cannot be identified
before they pay, which is precisely the argument for a free scorecard rather
than for a higher price.

### Recommendation

**$29 one-time, behind a free deterministic scorecard.**

Reasoning:

- At $49 the product must beat a free bank statement by $49. At $29, behind a
  scorecard that has already shown the customer a real number, the purchase is
  trivially rational — they are buying the per-line detail on savings they have
  already been shown.
- $29 matches `/buying`, sits correctly below `/home-savings` at $49 (which
  genuinely does more), and above `/streaming` at $19.99/yr (which is narrower).
  The current $49 makes the line incoherent in both directions.
- The free scorecard, not the price, does the conversion work. `/closing` proves
  this pattern on a $59 product at the same company.
- Do **not** go lower. Below ~$19 the product loses to "I'll just look at my
  statement" on perceived seriousness rather than on price, and it cannot fund
  the statement-extraction model call.

**Model: free scorecard -> $29 one-time report.** Optionally, later, a
$19.99/yr rotation tier — restart dates, renewal-date reminders, price-rise
alerts — which is the only genuinely recurring value here, and which is exactly
the product `/streaming` already is. Generalizing that engine is a far better
second act than charging more for the first one.

**Do not** price per subscription analyzed. It taxes the customer for being
honest about how many they have, at precisely the moment you need a complete
list.

---

## I. Copy recommendations

| Where | Now | Replace with | Why |
|---|---|---|---|
| H1 | "Optimize every subscription you're paying for." | **"You are paying for something you stopped using."** | States the customer's problem. "Optimize" is not a benefit and not a verb anyone uses about their own money. |
| Sub | "Not just streaming — software, memberships, boxes, apps. Tell StreamNavigator what you're subscribed to and it recommends what to keep, cancel, rotate, or downgrade." | **"List what you pay for and answer three questions about each. You get one call on every line — keep, downgrade, pause or cancel — with what it saves, and for a pause, the date to start again. No bank login, ever."** | Names the input, the output, the number, the date, and the privacy point in one sentence. |
| Pill | "Beyond streaming — every subscription you pay for" | **"No bank login. No account access. You tell us, we decide."** | Moves the strongest trust claim from FAQ #2 to the first line on the page. |
| Step 1 | "List or upload your subscriptions" | **"List them, or drop in a statement. A statement fills in the prices for you."** | Tells the customer what the upload buys them. |
| Step 3 | "AI reviews usage and value" | **"Three taps per subscription: when you last used it, whether you'd miss it, who else uses it."** | "AI reviews" is the least credible sentence on the page. This one is checkable. |
| Step 4 | "Get your keep/cancel/rotate list" | **"A call on every line, with the dollar figure — and the ones we won't decide for you, marked."** | Sells the restraint, which is the trustworthy part. |
| "What you get" | "Direct links to cancel or downgrade where available" | **Delete, or build the link table first.** | Sold, not delivered. See C5. |
| "What you get" | "Total estimated annual savings" | **"One savings total you can check — confirmed savings only, with the conditional ones listed separately."** | Commits to the accounting discipline in E.4. |
| New section | — | **"What this does not do"** — we do not connect to your bank; we do not cancel anything for you; we cannot know what a service will cost if you come back; where the decision is yours (shared plans, bundles, anything holding your data) we say so instead of guessing. | `/closing` has this and it is the most trust-building block on that page. |
| New line in intake card | — | **"Your statement is read once and the copy sent for analysis is deleted immediately. The upload stays in encrypted storage for 90 days so we can regenerate your report, then is deleted automatically."** | Already true (`privacy-policy.html:118`). Unstated at the moment of upload, where it matters. |
| CTA | "Get My Report →" | **"Show Me What I'm Wasting — Free"** (scorecard), then "Get the full report — $29" | The first click must not be a payment. |
| Final CTA | "You're probably paying for something you forgot about." | **"Most households find two. Some find six."** | Specific beats probable. |
| FAQ, new | — | **"What if you find nothing?"** — Then you will know before you pay: the free scorecard shows it. | Direct lift from `/closing`. |
| Footer disclaimer | keep as-is | — | Accurate and well-judged. |

Delete: "Optimize", "AI reviews usage and value", the 📎 and 🔒 emoji in the
intake card, and the 12 emoji in the footer nav.

---

## J. Design recommendations

`/closing`'s system is already extracted as `navigator-editorial.css`, already
adopted by `/contractor`, and already guarded by `tests/contractor-design.test.js`,
which compares the file against the inline block in `closing.html` character for
character. **Migrating `/subscriptions` is a known, tested path, not a redesign.**

| | `/closing` (standard) | `/subscriptions` (now) |
|---|---|---|
| Stylesheet | `navigator-editorial.css` | `navigator-shared.css` |
| Body type | IBM Plex Sans, 17px / 1.6 | Inter, 16px / 1.55 |
| Headings | Newsreader serif, weight 500 | Sora, weight 700–800, `letter-spacing:-0.02em` |
| H1 | `clamp(2.2rem,5vw,3.3rem)`, line-height 1.09, left-aligned | gradient-filled, centered |
| Page background | flat `--paper #FBFAF7` | `--bg-gradient` violet/mint + `.bg-noise` radial overlays |
| Ink | `#1B2A3A` | `#201A14` |
| Accent | `--flag #B01F12`, used only on findings and step numerals | `--gradient #8B5CF6 -> #EC4899`, used decoratively |
| Radius | 2px | 20px / 12px |
| Cards | 1px solid ink, `5px 5px 0 rgba(27,42,58,.08)` | 2px black border, `6px 6px 0` solid hard shadow |
| Section dividers | 1px `--rule #D8DAD5` hairlines | colored background bands |
| Buttons | ink fill, 2px radius, weight 500, `14px 26px` | gradient fill, pill, weight 700+ |
| Layout | left-aligned, `.wrap` 1080 / `.col` 780 | centered, `.wrap` 1180 |
| Steps | numbered list, mono numerals in flag red, hairline rules | 4 rounded cards with gradient number circles |
| Numerals | IBM Plex Mono, `font-variant-numeric: tabular-nums` | proportional Inter |
| Emoji in body | none | 📎, 🔒, 12 in footer nav |
| Nav | text brand `StreamNavigator / Closing Disclosure Audit`, hairline rule | gradient logo mark with hard shadow + teal sub-brand pill |
| Section padding | `60px 0`, uniform | ~90px, overridden inline per section |
| Mobile | left-aligned, reflows to one column cleanly | H1 centered, wraps to five lines; nav CTA drops to a second row |

Tabular numerals matter more here than anywhere else on the site: this report is
a column of dollar figures, and `/closing`'s `.mono` / `.row .amt` treatment is
what makes its ledger readable. The `.ledger` component transfers to the
subscription table with no change at all.

Migration: swap the stylesheet, replace `.step-card` with `.steps`, `.price-card`
with `/closing`'s intake card, `.check-card` with `.checks`, and the hero block
with `.hero-grid` + a `.ledger` sample showing one real subscription row. The
`field-block` / `label` / `field-hint` / `upload-zone` class names are shared
already, so the form markup carries over unchanged. Then extend
`tests/contractor-design.test.js` to cover the third page.

---

## K. Prioritized implementation plan

### Phase 1 — Must fix (nothing ships to a paying customer until these are done)

1. **Build the structured intake.** Per-line: name, price, period, last used,
   would-you-miss-it, who-uses-it; optional seasonal / promo / bundled flags;
   plus an "I cancelled this and wonder if I should restart it" path. Statement
   upload pre-fills name/price/period.
2. **Add the sufficiency gate,** in `api/navigator-intake.js`, on the same rules
   the page gates its own button on — the `checkBuyingSufficiency` pattern
   exactly. At least one line with a name and a price, and the three taps
   answered for every line. No line, no checkout.
3. **Build the deterministic engine** (`navigator-subscription-engine.js`): the
   E.3 rules as a pure function, plus a service table carrying `canPause`,
   known cancel/manage URLs and tier structures — seeded from the 20 services
   already in `navigator-streaming-engine.js`, which is real, dated and verified.
   The model writes the findings up; it does not originate one. This is the
   house pattern (`closing-audit.js`, `landlord-audit.js`, `rental-audit.js`)
   and it is the only reason those products can be trusted.
4. **The three safety rules, as hard blocks:** never CANCEL a prepaid annual
   mid-term; never CANCEL a shared plan; never CANCEL something holding the
   customer's data or bundled with something else. Each becomes REVIEW with the
   reason named.
5. **Separate ROTATE from CANCEL** on the `canPause` flag, and never use "rotate"
   on a service that cannot hold.
6. **Fix the cancellation-link claim** — build the table or cut the promise. Add
   a test to `tests/navigator-claims.test.js` so it cannot come back.
7. **Savings accounting** (E.4): confirmed / conditional / at-risk / unpriced,
   never totalled across kinds. Test it the way `rental-audit` is tested.
8. **Reprice to $29** and update `prices.config.json` first, then the page, then
   `npm run check-prices`.

### Phase 2 — Should fix

9. **Free deterministic scorecard** before payment. The engine from item 3 makes
   it free to run on a typed list; only statement extraction costs a model call.
10. **Migrate to `navigator-editorial.css`** and extend the design parity test.
11. **Rewrite the copy** per section I, including the "What this does not do"
    block and the retention line in the intake card.
12. **Per-subscription ledger output** (section G) — either a `subscriptions`
    branch in `navigator-status.html` or a dedicated view like
    `closing-scorecard-view.js`.
13. **Refund position** matching `/closing`: if the report misses what it
    promised, refund in full.
14. **Narrow `/home-savings` copy** so it stops selling memberships and
    subscriptions, and cross-link the two pages instead of competing.
15. **Clean up:** remove the dead `.category-chip` handler; sweep the two
    `audit-test@example.com` submissions.

### Phase 3 — Nice to have

16. **Rotation calendar tier**, $19.99/yr — restart dates, renewal reminders,
    price-rise alerts. Generalize `navigator-streaming-engine.js` rather than
    writing a second one.
17. **Duplicate-coverage detection** across lines (three streaming services, two
    cloud storage plans, two music services).
18. **Annual-charge blind spot:** ask explicitly about subscriptions that bill
    once a year, because they do not appear on the statement the customer
    uploads and they are among the largest.
19. **Re-run free for 90 days** when a customer comes back with the price they
    could not find.

---

## The one thing to understand before trusting a green run

This product's test surface is `tests/navigator-claims.test.js`, and it passes.
It passes because it checks that the page does not sell a *year* it cannot
grant, and does not sell *reference data* that does not exist. It does not check
that the page sells cancellation links the prompt forbids, that the intake
accepts a single character, or that the engine is a paragraph of prose.

Every defect in section C is invisible to the suite. The pattern is the one
`docs/BUYING-ENGINE-AUDIT.md` already names: **this engine fails by producing
plausible output.** A customer who submits "Netflix, Hulu, Spotify, gym" will
get back a confident, well-written, correctly-formatted report containing four
recommendations, a savings total, and no indication anywhere that the product
was never told when any of them was last used.

That report will look exactly like a good one.

---

# Part II — What was built, 2026-09-19

The audit above was written first and is left exactly as it was. This part
records what was done about it the same day, and what was deliberately not.

## The shape of the fix

`/subscriptions` now works the way `/closing`, `/rental` and `/landlord` work:
a deterministic engine decides, and the model writes up what it decided.

- **`navigator-subscription-engine.js`** (new, repo root). The rules from
  section E.3 as a pure function, plus a behaviour table. It lives beside
  `navigator-streaming-engine.js` and for the same reason — it is required by
  the API *and* served to the browser, so the check that decides whether a
  customer may pay and the check the server enforces are one file, not two
  copies that drift.
- It **requires the streaming catalog** rather than copying it, so the 20
  hand-checked cancellation URLs, the per-service pause policies and the
  verified tier prices have exactly one home.
- **`api/navigator-intake.js`** gates `subscriptions` on
  `checkSufficiency()` — the `checkBuyingSufficiency` pattern, applied to the
  product that never had it.
- **`api/_lib/navigator-engine.js`** runs the engine and hands the writer the
  decisions as data. The five-sentence prompt is replaced with a write-up brief
  that forbids originating an action, a figure, a date or a URL.
- **`subscriptions.html` / `subscriptions-intake.js`** (rewritten): per-line
  editor, three taps, optional flags, restart path, and a **free scorecard
  computed in the browser**.
- **`navigator-status.html`** renders the ledger from
  `report.subscription_analysis` — the engine's arithmetic, not a re-parse of
  the prose about it.

## The three safety rules, as invariants

`applySafety()` is a pass that can only ever downgrade an action.
`tests/subscription-engine.test.js` enumerates every combination of answers a
customer can give — about 5,000 inputs — and asserts that **no input at all**
produces a cancel on a shared plan, on a prepaid annual plan mid-term, or on
anything holding the customer's own files. An example test would have caught
the three cases somebody thought of; these catch the ones nobody did.

Two more invariants over the same input set: no line without a price ever
receives a figure, and no saving ever exceeds what the subscription costs in a
year. Two more by enumeration: a URL is only ever produced for a service whose
URL is in the hand-checked table, and the word "rotate" is never used on a
service that cannot actually hold.

## Two bugs the build found in itself

Worth recording, because both produced plausible output rather than an error.

**A fired safety block silenced the later ones.** Each block tested the
*running* action rather than the one the usage rules produced, so the first to
fire ended the chain. A shared music plan that also holds the customer's
playlists came back citing the data risk and never mentioning that somebody
else in the house uses it daily. Found by reading the output of a smoke run,
not by a failing test.

**A more specific answer was replaced by a vaguer one.** An annual Adobe plan
hit both the annual-plan block and the holds-data block; the second overwrote
the first and dropped the March renewal date, which was the entire useful part
of the answer. Found by a scenario test.

## The free scorecard

Deterministic, so it costs nothing to run, so it can genuinely be free — which
is the whole argument. It runs in the browser on the same engine, and **nothing
leaves the page to produce it**, which is what makes "no bank login, ever" more
than a slogan. It shows counts and totals and is tested to leak neither the
per-line answers, nor the steps, nor the links.

## Price

**$29**, displayed. The Stripe Payment Link for it does not exist yet, and one
manual step remains that only the account holder can take.

Until then the button's href is the literal `REPLACE_WITH_29_ONE_TIME_LINK` and
the page's own script **refuses to navigate**, showing the customer why. A page
displaying $29 against a button that charges $49 is precisely the defect
`scripts/check-prices.js` was written for after buying.html showed $39 while
its button pointed at the $19 link, and shipping it would have been worse than
shipping nothing. `subscriptions.html` is in `_skipped` in `prices.config.json`
with the reason and the steps; the old $49 link is recorded under
`unreferencedActiveLinks` as one to deactivate.

**To finish:** create the $29 one-time price and Payment Link in Stripe, put
the URL in the page and in `stripeLinkId`, move the entry back into `pages`
with `expectedPriceCents: 2900`, deactivate `4gMaEXbsw2E49co5RKabK07`, and run
`npm run check-prices`.

## Design

`navigator-editorial.css`, the system `/closing` and `/contractor` already use.
Verified by computed style rather than by eye, against the live `/closing`:
IBM Plex Sans 17px/1.6, `#FBFAF7` paper, `#1B2A3A` ink, Newsreader 500
headings, left-aligned h1, ink-filled 2px-radius button at weight 500, 1px
hairline sticky nav, tabular mono numerals — identical on every token. No
horizontal overflow at 440px.

## Status against the plan

| | Item | Status |
|---|---|---|
| 1 | Structured intake | done |
| 2 | Sufficiency gate, same rules both sides | done |
| 3 | Deterministic engine | done |
| 4 | Three safety rules as hard blocks | done, as invariants over ~5,000 inputs |
| 5 | ROTATE separated from CANCEL on `canPause` | done |
| 6 | Cancellation-link claim fixed, with a test | done |
| 7 | Savings accounting by kind | done |
| 8 | Reprice to $29 | done on the page; **one Stripe step outstanding** |
| 9 | Free scorecard before payment | done, client-side |
| 10 | Editorial design system + parity test | done |
| 11 | Copy rewritten, limits and retention stated | done |
| 12 | Per-line ledger output | done |
| 13 | Refund position | done |
| 14 | `/home-savings` narrowed, cross-linked | done |
| 15 | Dead `category-chip` handler; orphan rows | handler removed. The two rows were inserted with `is_test = true` automatically — `example.com` is RFC-reserved and `api/_lib/test-submissions.js` catches it — so no sweep was needed. Section C's M5 overstated this. |
| 17 | Duplicate-coverage detection | done |
| 18 | Annual-charge blind spot | done — named on the page and asked for per line |
| 19 | Re-run free | done — the scorecard is free and unlimited, and the report says so per line |
| 16 | Rotation calendar tier, $19.99/yr | **not done, deliberately.** The engine computes the restart dates and the report carries them, so the data exists. Creating a second recurring paid tier is a commercial decision with a Stripe product behind it, and the right next step is to generalize `navigator-streaming-engine.js` rather than to bolt a subscription onto a one-time product. |

## What is still untested

The server-side gate and the paid generation path cannot be exercised without a
deploy and a paid run, and no model credits were spent on this work. What is
proven: the engine, the gate rules, the scorecard, the page and the ledger
renderer, all against the shipped source. What is not: that a real Stripe
payment reaches the engine and returns the report described above. That needs
one live run after the $29 link exists.
