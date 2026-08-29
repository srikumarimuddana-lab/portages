# AWS SES + SMS — setup

What you end up with: transactional email sending, and SMS to Canadian
numbers.

**Time:** ~30 minutes of work, plus review queues measured in days.
**Cost:** pay per message.

> **Start this early.** SES production access and Canadian SMS registration
> both go through AWS review. Neither is something you can rush at the end.

---

## Part 1 — Email (SES)

### 1. Pick the region

Use **`ca-central-1`**. SES pricing is uniform across regions, so there is no
reason to put your sending — and your bounce data — outside Canada.

### 2. Verify your domain

**SES → Configuration → Identities → Create identity → Domain**

Enter `portage.ca` and enable **Easy DKIM** (RSA_2048). AWS gives you three
CNAME records; add them at your DNS provider. Verification usually completes
within an hour.

Then add these two records yourself — AWS does not create them:

| Type | Name | Value |
|---|---|---|
| TXT | `portage.ca` | `v=spf1 include:amazonses.com ~all` |
| TXT | `_dmarc.portage.ca` | `v=DMARC1; p=none; rua=mailto:dmarc@portage.ca` |

Start DMARC at `p=none` so you can read reports without silently dropping
mail, then tighten to `quarantine` once the reports look clean.

### 3. Leave the sandbox

New accounts can only send to addresses you have verified, capped at 200
messages/day.

**SES → Account dashboard → Request production access.** Be specific about
what you send — transactional only, saved-search alerts with express opt-in,
how you handle bounces and unsubscribes. Vague requests get rejected. Turnaround
is typically 24 hours but can take longer.

### 4. Configuration set — do not skip this

**SES → Configuration sets → Create.** Name it `portage-transactional`, and add
an event destination for **Bounce**, **Complaint**, **Delivery** and **Reject**
pointing at SNS or EventBridge.

**Suppress on hard bounce and complaint.** Sender reputation is not
recoverable by apology — once you are sending to dead addresses, deliverability
falls for everyone.

### 5. Credentials

Create an IAM user with only `ses:SendEmail` and `ses:SendRawEmail`, scoped to
your verified identity. Store the keys in Vercel environment variables scoped
to Production.

---

## Part 2 — SMS (AWS End User Messaging)

> SMS charges moved off the SNS bill to **AWS End User Messaging** on
> **2024-11-01**. If a guide tells you to look under SNS for SMS pricing, it
> predates that change.

### 1. Request an originator for Canada

**AWS End User Messaging → Phone numbers → Request originator**

| Field | Value |
|---|---|
| Country | **Canada** |
| Use case | Transactional (one-time passwords, alerts) |
| Type | **Toll-free** (fastest for Canada) or 10DLC |

Canadian toll-free numbers require **verification** — business details, sample
messages, opt-in description. **This is the long pole: allow days to weeks.**

Your sample messages must match what you actually send, including the opt-out
line.

### 2. Leave the SMS sandbox

Same shape as SES: the sandbox only sends to verified numbers. Request
production access from the console.

### 3. Opt-out handling is mandatory

Canadian carriers require STOP/UNSTOP handling. AWS handles the keywords, but
**your database must reflect it** — a user who texts STOP has revoked consent,
and the `consents` table is what the notification layer checks before sending.

---

## Consent — the part that is law, not preference

CASL penalties reach **$10M per violation**. The schema already blocks a saved
search from enabling alerts without a consent row, and `notify.send()` refuses
any non-transactional message without a live one.

| Message | Consent needed |
|---|---|
| OTP, password reset, booking confirmation | Transactional — no express consent required |
| Saved-search alerts | **Express opt-in**, unchecked by default |
| Marketing | **Express opt-in**, separate from the above |

Every commercial message needs sender identification and a working
unsubscribe. Log the consent — what was agreed, when, and how — because the
burden of proof is on the sender.

## Costs, in perspective

| Item | Rate |
|---|---|
| SES | ~$0.10 per 1,000 emails |
| SMS to Canada | a few cents per message — check the current rate |

At Regina scale email is a rounding error. **SMS is not** — it is the one
channel where a runaway loop costs real money, which is why it sits behind a
kill switch.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Email address is not verified` | Still in the sandbox, or the identity isn't verified. |
| Mail lands in spam | SPF/DKIM/DMARC incomplete, or reputation damaged by unsuppressed bounces. |
| SMS silently not delivered | Originator not verified, or the recipient has opted out. |
| `Throttling: Maximum sending rate exceeded` | Above your SES rate limit. Queue and retry with backoff — the notification layer does this. |
