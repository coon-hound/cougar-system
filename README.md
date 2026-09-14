# Cougar Data System

A single source of truth for 40 SAR Cougar Company training, medical and fitness data.

Phone-first web app on top of a Google Sheets backend.
Vanilla JavaScript, no server, no build step, no framework.
Commanders open it on their phones to manage roster, attendance, medical status, leave, IPPT / route-march / SOC results, and Polar heart-rate analytics.

## Quick start

It is static files.
Open `index.html` directly, or serve the folder with any static server.
There is no `npm install` step for the app itself.

```bash
npm install        # only needed for the test suite (Playwright)
npm test           # unit + static load-time guards
npm run test:e2e   # real-browser end-to-end specs
```

To talk to real data you need a device auth token in localStorage (`cougar-auth`), which you get by opening the app once through an invite link.

## Where things live

| Path | What it is |
|---|---|
| `index.html` | App shell: sidebar nav, topbar search/filter, modal host. Carries the `?v=` cache-buster. |
| `styles.css` | All styling, including mobile breakpoints. |
| `js/` | The front end, loaded as plain `<script>` tags in a fixed order. See [docs/HANDOFF.md](docs/HANDOFF.md). |
| `apps-script-Code.gs` | The entire backend, mirrored from the deployed Google Apps Script project. |
| `test/` | Zero-dependency sync/backend tests plus Playwright e2e specs. See [test/README.md](test/README.md). |
| `scripts/` | The ship pipeline: `new-feature.sh`, `verify.sh`, `preview.sh`, `ship.sh`. |
| `docs/` | Everything below. |

## Documentation

Start with the one that matches what you are here to do.

| Doc | Read it when |
|---|---|
| [docs/HANDOFF.md](docs/HANDOFF.md) | You are working on the code. Architecture, the `STATE` data model, auth and deployment, and the gotchas that will bite you. **The main developer document.** |
| [docs/PIPELINE.md](docs/PIPELINE.md) | You are about to ship a change. Worktree per feature, the verify gate, PR flow. |
| [docs/SETUP.md](docs/SETUP.md) | You are standing up a brand new instance for another company, from zero to a working Sheet, Apps Script and hosted frontend. |
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | You are using the app. Feature by feature, organised by the sidebar. |
| [docs/DATAFLOW.md](docs/DATAFLOW.md) | You want the input-to-output picture of how data moves through the system. |

`CLAUDE.md` at the repo root is the condensed version for coding agents.

## The three things that most often go wrong

1. Change any JS or CSS and you **must** bump `?v=` in `index.html`, or phones keep running stale cached code.
2. Prefer `upsertRow` / `deleteRowById` over a full-table `pushTab` write, so two phones editing different rows cannot clobber each other.
3. `apps-script-Code.gs` in this repo is a mirror of the deployed Apps Script project. Edits in one do not propagate to the other.

Full list with the reasoning behind each: [docs/HANDOFF.md §6](docs/HANDOFF.md).
