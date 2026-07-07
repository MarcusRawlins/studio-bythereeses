# Change requests — Tyler's notes on what to change

This is the **single intake list** for changes Tyler wants to the CRM. Walk the live site
(`schedule.bythereeses.com` public, `studio.bythereeses.com` admin — your Google login) with
`docs/app-surface-map.md` open as a checklist, and add one entry here per change you want. An agent
(any capability level) then picks up each entry, writes a spec, gets it Fable-reviewed, builds it
**dark**, and reports back — you flip it on.

## How to add a request (so any agent can act on it without guessing)

Copy the block below and fill every field. The more concrete the **Now** and **Want**, the less an
agent has to guess. A screenshot pasted into `Notes` (or a file dropped in `docs/change-shots/`) is
worth a paragraph.

```
### CR-<n> — <short title>
- Status: OPEN            # OPEN | SPEC | BUILDING | DARK (built, flag off) | LIVE | WONTDO
- Screen: <route + name from app-surface-map.md, e.g. /projects/:id — Project detail>
- Host: <admin | public>
- Priority: <P1 blocks me | P2 want soon | P3 nice-to-have>
- Now: <what the screen does / shows today>
- Want: <what you want it to do / show instead — be specific about the outcome>
- Why: <the business reason — helps the agent make the right call on edge cases>
- Money/risk: <does this touch payments, refunds, sending email/SMS, or client-visible data? yes/no>
- Notes: <anything else — examples, a competitor that does it well, a screenshot path>
```

**Rules an agent MUST follow on every request** (these are the standing guardrails for this repo —
see `docs/handoff-build-state.md` for the full list):
- Build it **dark** behind an off-by-default flag. Never enable it yourself — Tyler flips the flag.
- Anything that moves money (refund/charge/autopay) or sends outbound email/SMS **pauses for Tyler's
  explicit go** before the first live action, and gets an Opus/Fable money-math review.
- Every spec and every code diff gets a **Fable review** before it lands.
- Never commit the Cloudflare API token or any secret to the repo.
- Green build gate required: `npm run lint` (exit 0), `npm run build` (**exit 0** — type errors print
  after "Compiled successfully"), `npm test` (all pass).

## Priority legend
- **P1** — blocks my day-to-day / something is wrong or missing that I hit constantly.
- **P2** — clear improvement I want in the next batch.
- **P3** — nice-to-have, do when convenient.

---

## Worked example (delete or keep as a reference)

### CR-0 — Show remaining balance at top of project detail
- Status: OPEN
- Screen: /projects/:id — Project detail
- Host: admin
- Priority: P2
- Now: The balance is only visible after scrolling to the invoice section.
- Want: A summary strip at the top of the project page showing total, paid, and remaining balance.
- Why: I check "what do they still owe" constantly and don't want to scroll.
- Money/risk: no (read-only display of existing numbers).
- Notes: HoneyBook shows this as a little pill row under the client name.

---

## Requests

<!-- Add CR-1, CR-2, … below. Newest at the bottom is fine; the agent works by priority, not order. -->
