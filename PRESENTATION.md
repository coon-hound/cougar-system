# Cougar Company Data System — Battalion HQ Pitch Deck

> Slide-by-slide draft. Each slide = on-screen content (keep it sparse) + speaker notes (what you say).
> Fill every `[bracket]` with your real numbers before presenting. Target: ~18–20 min + Q&A.
>
> **Structure — two acts:**
> - **ACT 1 (Slides 1–11): The app today at Cougar.** What it is, how people actually use it, what it does for us, and its honest drawbacks.
> - **ACT 2 (Slides 12–18): Feasibility & battalion-wide.** What every appointment gets, the battalion roll-up, how other companies adopt it, security, and the ask.
>
> **Read the Speaker Cheat-Sheet at the bottom first** — it maps every person in the room to the one thing they care about.
>
> **Visual style (every slide is a photo, not text):**
> - Each slide carries **one full-bleed hero image** (edge to edge); the bullet text below is your *speaker reference*, not what goes on the slide. Put at most the **overlay** words on the actual slide.
> - Lay overlay text over a **dark gradient strip** (bottom or side) so it's always readable — reads as intentional, not clip-art.
> - Keep **one consistent treatment** across all 18 photos (same subtle duotone / filter in unit colours) so different photos still feel like one deck.
> - ⚠️ **OPSEC:** use unit-cleared photos only; blur nametags, faces, unit markings, sensitive locations. For shots you can't take, generic stock (Unsplash/Pexels) works for everything except the app screenshots.
>
> **Slide-design rules baked in (Naegle, "10 simple rules"):**
> - **One idea per slide** (Rule 1) · **~1 min each** (Rule 2) → ~18 slides for ~18 min.
> - **The heading IS the takeaway** (Rule 3 & 8) — every slide title below is written as a *conclusion*, not a topic, so a distracted person who reads only the title still gets the point. If you remember one thing per slide, make it the heading.
> - **≤6 elements per slide, fragments not sentences** (Rule 4 & 7) — the on-screen bullets are guideposts; *say* the detail, don't print it. Reading + listening compete for the same channel.
> - **Graphics carry it** (Rule 6) — hence the hero image on every slide.
> - **No fly-ins / animations** (Rule 10) — surveys show audiences dislike them and they break on host laptops. **Save a PDF copy** as your disaster backup; keep proof screenshots for the live demos.
> - Sans-serif, large type, high contrast, colour-blind-safe palette (Rule 7).

---
---

# ACT 1 — How it works for Cougar today

---

## Slide 1 — Title

> 🖼 **Image:** Full-bleed wide shot of the company in formation on the parade square at first light (or the Cougar crest beside a phone showing the dashboard). **Overlay:** title block only.

**On screen:**
- **40 SAR Cougar — Company Data System**
- One source of truth, from the section line to battalion HQ
- [Your rank/name/appointment] · [date]

**Speaker notes:**
> 10 seconds. "I'm going to show you a system we built and have been running in Cougar. First how it works for us day-to-day — including where it falls short — then what it would take to give the whole battalion one accurate picture."

---

## Slide 2 — "We rebuild parade state by hand, every day" *(the hook)*

> 🖼 **Image:** A phone screen flooded with chaotic WhatsApp group messages + notification badges; or a COS hunched over paper nominal rolls late at night. **Overlay:** *"Every day. By hand."*

**On screen:**
- Parade state is rebuilt by hand, every day, from WhatsApp + memory
- Conduct attendance, LMS, IPPT — captured, then thrown away
- No single place to ask "how is our training actually going?"
- At handover/POP, the company's memory is lost

**Speaker notes:**
> Get the room nodding before features. "In most companies the COS rebuilds parade state daily from report-sick timings and conduct attendance scattered across chats. The harder data — IPPT, LMS — someone parses by hand. It works, but it's fragile, manual, and none of it accumulates into anything we can decide from." Pause. "This is the company's memory."

---

## Slide 3 — "One source of truth, updated from your phone in seconds" *(framing)*

> 🖼 **Image:** Clean close-up — one hand holding a phone with the app dashboard open, camp/field softly blurred behind. Deliberate contrast to Slide 2's mess. **Overlay:** none.

**On screen:**
- A phone-first web app + Google Sheets backend
- Updated from the ground in seconds (no laptop)
- [N] recruits · [N] modules · [N] conducts archived
- *Screenshot of the sidebar*

**Speaker notes:**
> "One sentence: a single source of truth any commander updates from their phone, on the ground, in seconds. No server to buy, no app to install — Google Sheets underneath, so it's free and familiar."

---

## Slide 4 — "No install, one link, works offline — so people actually use it" *(accessibility)*

> 🖼 **Image:** A commander checking the app in the field (rugged terrain, clearly no desk); or 4–5 hands each holding a phone showing the app. Optional small inset: a QR / invite link. **Overlay:** *"No install. One link. Works offline."*

**On screen:**
- **No install, no app store** — it's a URL, opens in any phone browser
- **Log in once** — invite link redeems a device token; never log in again
- **Works offline** — data is cached on the device; reads are instant, syncs when signal returns
- **Data is just *there*** — auto-pulls on launch; search by 4D or name; scope to platoon/section in one tap
- **Onboard a whole team in one message** — drop one bulk-invite link in the group chat; each phone self-registers

**Speaker notes:**
> This is the adoption argument — make it explicitly. "A data system only works if people actually use it, and people don't use things with friction. So: nothing to install, you log in once per device and never again, and it works with no signal — it reads from a local cache and syncs in the background. When you open it, the data's already there; you search a 4D and you're looking at the man in two seconds." For onboarding: "I can bring a whole company on with a single link in the group chat — each phone registers itself." Low friction is *why* the data stays current.

---

## Slide 5 — "Twelve modules, four jobs" *(core features)*

> 🖼 **Image:** A 2×2 photo grid, one per bucket — formation (accountability), medic/MO line (safety), recruit running IPPT (performance), phone-in-field (usability). The only grid slide; four photos replace four words. **Overlay:** one bucket label per quadrant.

**On screen — 4 buckets:**

| Bucket | Covers |
|---|---|
| 🪖 **Accountability** | Roster · Attendance · Leave/Out · Conducts |
| 🏥 **Training safety** | Medical · MSK trends · HA expiry · Report Sick |
| 🏃 **Performance** | IPPT · Route March · SOC · Polar HR analytics |
| 📲 **Field usability** | Telegram bot · AI photo capture · offline sync |

**Speaker notes:**
> "Twelve modules, four jobs." Name each bucket in a line. "Let me show the two that change how we see the company — the heart-rate analytics and the AI data capture."

---

## Slide 6 — "We can see whether training is actually working" *(DEMO 1 — performance)*

> 🖼 **Image:** Split frame — real screenshot of the recruit growth graphs on one side, a recruit wearing a Polar watch/chest strap sweating during PT on the other. Data ↔ the human it measures. **Overlay:** none (let the graph read).

**On screen:**
- Tap a recruit → growth graphs over the cycle
- **Efficiency** = kcal / avg HR · **Intensity** = avg HR / max HR
- **Recovery** = max-HR trend at same workload (fitness vs. fatigue)
- **Workload** = avg HR × duration (cardiac load → periodisation)
- Company-wide: conduct participation, fallout & report-sick patterns

**Speaker notes:**
> Do this LIVE on your phone. "This is a recruit's fitness across the cycle — not raw numbers, but training-science metrics. Recovery flags overtraining before it's an injury; workload lets us periodise instead of guess. Aggregate it and the OC/SM see MSK trends, IPPT progression, who's falling out repeatedly — decisions on evidence, not feel."

---

## Slide 7 — "One photo logs an entire class" *(DEMO 2 — automation)*

> 🖼 **Image:** Someone photographing a Polar Flow class-summary screen with their phone (the AI capture mid-action) — shows the automation literally happening. **Overlay:** *"One photo → 22 recruits."*

**On screen:**
- **AI photo capture** — photograph the Polar class summary → every recruit's HR/cal/duration extracted, matched to roster, unclear rows flagged
- **Telegram bot** — update status from the field, no laptop, no app
- **Google Form** — MSK/physio self-reports flow straight in
- **Email** — push status/Polar summaries out to the chain

**Speaker notes:**
> Ties back to Slide 4. "The hardest part of any data system is getting data *in* — so we automated the three worst chokepoints." Show the AI photo capture. "It reads every row, matches each 4D to our roster, and *flags* what it can't read rather than silently dropping a recruit. Plus a Telegram bot for field updates and a Google Form for injury self-reports — easy to bolt new inputs on."

---

## Slide 8 — "Parade state generates itself — in battalion format" *(company-level, today)*

> 🖼 **Image:** Real screenshot of the generated parade-state message on a phone (blur names/4Ds); or a chief safety briefing recruits with phone in hand. Proof it produces the real format. **Overlay:** none.

**On screen:**
- Generates **First / Last Parade** state in the battalion WhatsApp format — one tap to copy
- OTHERS, MEDICAL APPT, in-camp / out-of-camp all composed automatically
- Live **status board**: who's MC, LD, MC+1/+2, RMJ, each Excuse-status
- MC+1/+2 ghost tags computed automatically · HA-expiry warnings

**Speaker notes:**
> "Today this generates our parade state in the exact battalion format — the COS taps once to copy it into the chat, instead of typing it from scratch." Then for the safety angle: "It also compiles a live status board — every status, with MC+1 and MC+2 computed automatically so nobody tracks that on paper, plus heat-acclimatisation expiry warnings. A safety brief that builds itself." (This sets up the battalion roll-up in Act 2.)

---

## Slide 9 — "A missed book-in flags for review — not 'absent'" *(the honest answer on accuracy)*

> 🖼 **Image:** A commander booking out at the guardroom/gate — boom barrier, a visible clock. Literally the book-in/out scenario. **Overlay:** *"Out 1130 · In 1630"*

**On screen:**
- Parade state is only as good as its last input — same as today, but with less friction
- **Time-bounded entries:** log "out 1130 / in 1630" *once* → state auto-reflects the right status at any time in between
- **Self-service:** commander books in/out from his own phone (Telegram) — no single COS bottleneck
- **Fail-safe:** overdue book-in shows as *"pending verification,"* not silently "absent"
- **Human-in-the-loop:** COS/PS still verify before sendout

**Speaker notes:**
> Pre-empt the killer question — raise the sendout example yourself. "A commander books out 1130, in 1630. Parade state at 1300 must show him out. Who inputs that, and what if he forgets to book in?" Answer honestly: "You enter the window *once* and the system computes his status by current time — no one re-touches it. If he overshoots, he surfaces as *pending verification*, not wrongly absent. The COS still verifies before sending, exactly like today — we've just made that faster and harder to get wrong." Own the weakness; show the mitigation.

---

## Slide 10 — "Hours of daily admin become minutes" *(what it does for Cougar)*

> 🖼 **Image:** OC/SM studying a tablet/dashboard together, confident command-team body language — positive outcome, decisions made on data. **Overlay:** *"Hours → minutes."*

**On screen:**
- ⏱ **Manpower** — daily parade-state rebuild & data entry: hours → minutes
- 🛡 **Safety** — HA expiry + MSK trends + clean status board caught *early*
- 📊 **Decisions** — OC/SM act on participation, fallout & fitness trends, not gut feel
- 📁 **Accountability** — every conduct archived; nothing lost at handover/POP

**Speaker notes:**
> Translate to what command values: saved man-hours and reduced risk. "The COS stops rebuilding the picture from scratch daily. The OC and SM get trend lines they've never had. And the company's data survives the next handover."

---

## Slide 11 — "It's not magic: parts are still manual, and it leans on one person" *(close Act 1 on credibility)*

> 🖼 **Image:** Candid shot of one person manually keying data at a laptop, late, alone — conveys "still manual + key-man risk." **Overlay:** *"Still manual. Still one of me."*

**On screen:**
- **IPPT / LMS extraction still manual** — I parse it by hand to keep errors low
- **Data-entry discipline** is the real battle — the automation exists to lower that bar
- **Built on constraints** — Sheets-as-database meant engineering our own sync/conflict handling; no server meant a per-device token system
- **Key-man risk** — today it leans on one maintainer

**Speaker notes:**
> Close Act 1 by naming the limits — it's what makes the strengths believable. "I'll be straight about where it falls short. IPPT and LMS are still hard to extract cleanly, so I do that by hand for now. The hardest problem isn't code — it's getting consistent data entry. And right now it leans on me; if we scale, we resource that deliberately." Then pivot: "So — does this transfer beyond Cougar? That's the rest of the brief."

---
---

# ACT 2 — Feasibility & battalion-wide implementation

---

## Slide 12 — "Every appointment in this room gets something" *(the pivot to battalion-wide)*

> 🖼 **Image:** The actual audience world — an HQ conference room of appointment-holders, or a group photo of bn HQ staff. "This is for all of you." **Overlay:** *"Every appointment. One source."*

**On screen — table:**

| Who | What battalion-wide gives you |
|---|---|
| **S1** | Accurate parade state, consolidated to battalion level |
| **S2** | Per-device auth, revocable access, controlled data |
| **S3** | Battalion dashboard · training-effectiveness data · Form & Telegram automation |
| **RSM / CESP** | Accurate, *meaningful* Polar data + participation tracking |
| **SPECs (ground)** | Reliable in-camp / out-of-camp strength, live |
| **PCs / chief safeties** | Clean compiled status list — who's LD, MC+1, excused what |

**Speaker notes:**
> The pivot from "works for Cougar" to "works for all of you." Say each line *to* that person. "You've seen it run one company. Scaled to the battalion, here's what each of you gets — S1 a consolidated parade state, CESP Polar data you can trust, the SPEC on the ground a reliable in/out count, PCs a clean safety list. Same data, one source, every level."

---

## Slide 13 — "Many companies → one accurate strength state" *(the centrepiece for S1)*

> 🖼 **Image:** Aerial / wide shot of the whole battalion (multiple companies) massed on the square — scale you can't fake. Overlay a faint hub-and-spoke diagram (companies → one dashboard). **Overlay:** *"Many companies → one strength state."*

**On screen:**
- Each company runs its own instance (own sheet, own data)
- Battalion **pulls** from all companies → one consolidated parade state
- Read-only at battalion — companies stay independent & in control
- *Simple hub-and-spoke diagram: companies → battalion dashboard*

**Speaker notes:**
> The slide S1 is waiting for. "Because every company instance is identical, battalion can pull from all of them and consolidate into one accurate strength state — without touching any company's data. One number, traceable down to the recruit." Be honest on status: "The company side is live; this roll-up is the build I'm asking to resource."

---

## Slide 14 — "A new company stands up in [X days], for free" *(feasibility)*

> 🖼 **Image:** A second company's recruits / a different camp gate; or one hand passing a phone to another (handover) — "repeatable beyond Cougar." **Overlay:** *"Copy. Deploy. Done."*

**On screen:**
- ✅ **Low cost** — Google Sheets + Apps Script, free, no procurement, no server
- ✅ **Low barrier** — runs on any phone, nothing to install (same accessibility you saw in Act 1)
- 🔧 **To adopt:** copy Sheet → bind & deploy script → set frontend URL → issue invites
- ⚠️ **Honest:** needs Polar watches for the fitness side + one tech-comfortable maintainer per company

**Speaker notes:**
> "Standing up a new company is roughly [your estimate] — and I've written a setup guide, so it's repeatable, not tribal knowledge. The real dependencies are honest ones: Polar watches for the fitness data, and one maintainer per company. A sister company is already attempting the port — real evidence it transfers."

---

## Slide 15 — "The hard part is standardisation, not code" *(challenges in adapting)*

> 🖼 **Image:** Two companies' formations side by side looking slightly different; or mismatched puzzle pieces coming together. The standardisation problem, visually. **Overlay:** *"Only as clean as the least-consistent company."*

**On screen:**
- **Standardisation** — companies must agree on status vocabulary & roster format (the roll-up is only as clean as the least-consistent company)
- **Identity** — 4D numbers repeat across companies → namespace by company
- **Resilience** — one company offline must not break the battalion view (show partial + flag)
- **Maintenance** — a maintainer per company + someone who owns the battalion layer

**Speaker notes:**
> "Scaling isn't just copy-paste, and I want to be honest about the work. The biggest one isn't technical — it's standardising how companies record statuses, because the battalion picture is only as clean as the least-consistent company. The rest are solvable: namespacing IDs, handling a company being offline gracefully, and planning maintenance."

---

## Slide 16 — "Per-device, revocable, read-only at battalion" *(security — for S2)*

> 🖼 **Image:** A phone lock screen / fingerprint, or a hand at a card-access reader. Professional, not cartoonish. **Overlay:** *"Per-device. Revocable. Read-only up."*

**On screen:**
- Per-device token auth — no open/public access to data
- Invite-only onboarding; every device revocable individually
- Battalion roll-up is **read-only** — companies retain control of their data
- **For official adoption:** flag for proper data-classification review

**Speaker notes:**
> Raise it before S2 does. "Access is per-device and invite-only — I can revoke any single device, no public link. The battalion view reads up; it never writes down, so companies keep control." Then concede the right thing: "If this becomes an official battalion system, it should go through a proper data-handling review — I'm flagging that now rather than waiting to be asked."

---

## Slide 17 — "Resource the roll-up; pilot one more company" *(the ask)*

> 🖼 **Image:** Sunrise over the camp, or an open road / path ahead — forward-looking close. **Overlay:** your one ask, in a single line.

**On screen:**
- I'm requesting: **[pick one]**
  - Endorsement to pilot in [1 more company]
  - Resource the **battalion roll-up** build + a maintainer plan
  - Approval to standardise across the battalion
- I can stand up the next company in [timeframe]

**Speaker notes:**
> End on a decision, not "thank you." "I'm not asking the battalion to commit today. I'm asking to resource the roll-up and pilot it in one more company — so we have a second data point and a real battalion parade state to evaluate. Next company running in [timeframe]." Make the yes small.

---

## Slide 18 — Backup: architecture & numbers *(only if asked)*

> 🖼 **Image:** *Exception to the photo rule* — a clean hub-and-spoke architecture diagram is the right visual here (it's a technical backup slide). **Overlay:** the headline numbers.

**On screen:**
- Front end: vanilla JS web app (no framework, no build, works offline)
- Backend: Google Apps Script (bound to the Sheet) · Data: Google Sheets, one tab per module
- Integrations: Telegram · Claude AI (photo extraction) · Google Forms · email
- Roll-up: aggregator pulls each company's `readAll` API → merges
- **By the numbers:** [N] recruits · [N] conducts archived since [date] · [N] Polar sessions · [X] min/day COS admin saved

**Speaker notes:**
> One minute, no jargon, only if someone technical asks. One real number beats a paragraph of adjectives — pull these live before you present.

---

# 🎤 Speaker Cheat-Sheet — say *their* line to *their* face

| Appointment | What they want | Slide to land it | The one sentence to say to them |
|---|---|---|---|
| **S1** | Accurate battalion parade state | 13 + 9 | "You get one consolidated strength state, traceable to the recruit — and here's exactly how we keep the inputs honest." |
| **S2** | Security | 16 | "Per-device, revocable, read-only at battalion — companies keep control of their own data." |
| **S3** | Bn dashboard · effectiveness · automation | 6 + 7 + 13 | "Training effectiveness as data, three automated input paths, and a battalion dashboard that pulls it all together." |
| **RSM / CESP** | Polar accuracy & participation | 7 (+6) | "It flags unreadable Polar rows instead of dropping recruits — data you can stand behind — plus participation tracking and email-out." |
| **SPECs (ground)** | Reliable in/out-camp numbers | 4 + 9 | "It works offline, opens in two seconds, and a missed book-in flags for review instead of marking a man absent." |
| **PCs / chief safeties** | Compiled status list | 8 | "Your safety brief builds itself — every status, MC+1s computed automatically, HA expiry warnings, filtered to your conduct." |

---

## Delivery checklist
- [ ] Replace every `[bracket]` with real figures
- [ ] Charge your phone — Slides 6, 7, 8 are live demos
- [ ] Pre-load the app + pick one recruit with good Polar data; have a fallback screenshot
- [ ] Rehearse the **Slide 9** sendout-commander answer until it's smooth — your toughest question, pre-empted
- [ ] Know your one-line transition from Act 1 → Act 2 (end of Slide 11)
- [ ] Decide your single ask (Slide 17) before you walk in
- [ ] Print the Speaker Cheat-Sheet — glance at it, name people by appointment
- [ ] **Each slide ≤1 min in practice** — if one runs long, it's holding two ideas; split it (Rule 1 & 2)
- [ ] **Practice the transitions** — the last line of each slide should hand off to the next (Rule 9)
- [ ] **Export a PDF copy** and email it to yourself — your fallback if Keynote/PowerPoint misbehaves on the host laptop (Rule 10)
- [ ] **Strip all fly-ins/animations**; sans-serif, large type, high contrast, colour-blind-safe (Rule 7 & 10)
