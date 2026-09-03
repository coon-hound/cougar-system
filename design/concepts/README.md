# UI concepts

Three clickable front-end directions for the Cougar data system. They are
**drafts to react to**, not code to merge — each is a single self-contained HTML
file with no build step and no backend. Open one in a browser, or use the
published links below.

| | Concept | The bet | File |
|---|---|---|---|
| A | **Command Deck** | The current dense console, re-engineered. Same information per screen, but nothing opens in a modal: a row morphs into a context panel beside it, and `⌘K` jumps to any 4D. For the COS at a desk. | `a-command-deck.html` |
| B | **First Parade** | Phone-first and day-shaped. One screen is the morning; the battalion parade-state message assembles line by line as you tick people out of the conduct. For the PC on the ground at 0630. | `b-first-parade.html` |
| C | **Company Board** | Spatial. All 51 people as one pannable, semantically-zooming board; regrouping reflows it, and a scrubber runs the six-week cycle so you can watch statuses move. For seeing shape rather than rows. | `c-company-board.html` |

Published (private) artifacts:

- A — https://claude.ai/code/artifact/7f3e433f-efa3-415c-8f74-0425615a2892
- B — https://claude.ai/code/artifact/a51056eb-ee39-4d8c-ac05-57cc88d7b49d
- C — https://claude.ai/code/artifact/4c6267ef-5b23-45ff-a164-4a4b67b1698c

## What is shared, and what is deliberately not

All three run on the **same synthetic company** — 3 platoons × 15 recruits plus 6
commanders, with one of every case a commander has to reason about live at once
(MC, a trailing MC+1 ghost tag, LD, RMJ, an excuse, warded, leave, course, a
medical appointment out of camp, guard duty, three MSK cases). It follows
`scripts/dev-seed.mjs`: shapes and ratios mirror the live sheet, every date is
relative to today, and the people do not exist. `_seed.js` is the reference
copy; each concept inlines it so the file stays self-contained.

What is **not** shared is the visual language — that is the point of having
three. A keeps the Plex superfamily and the app's existing teal on a steel-black
ground; B commits to a daylight-legible light UI in the uniform's own olive,
set in Saira; C is a map — ink-teal ground, sand chrome, Barlow labels, and
state carried by its own four-colour scale so the board is readable at a zoom
where no text renders at all.

## Motion notes

Everything animates on `transform` and `opacity` only, off one spring curve
(`cubic-bezier(.22,1,.36,1)`), and every concept honours
`prefers-reduced-motion`. The pieces worth stealing regardless of which
direction wins:

- **A** — the row → panel shared-element morph, and the inline composer that
  expands with `grid-template-rows: 0fr → 1fr` instead of covering the table.
- **B** — the parade-state text assembling as you tick, and the bottom sheet you
  can throw down with a thumb (velocity + rubber-band).
- **C** — level-of-detail swapping at zoom thresholds, and the fact that layout
  positions are transforms, so regrouping is a free FLIP.
