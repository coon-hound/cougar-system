# Production pipeline

How a change goes from idea to production in this repo: one isolated worker per feature, a rigorous verify gate, self-contained evidence, and independent one-by-one pushes.
Built so several features (or several agents) can be in flight at once without stepping on each other.

## The unit of work: one feature, one worktree, one branch, one PR

`master` is production.
Every change is a short-lived branch off `master`, developed in its own `git worktree` under `.worktrees/<slug>` (git-ignored) so parallel workers never share a checkout.
Branch names: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`.
Because every feature branches from the same clean `master` and touches a disjoint surface, PRs can be reviewed, merged, and deployed in any order.

```
scripts/new-feature.sh feat my-thing      # worktree + branch off master
cd .worktrees/my-thing                     # do the work here
bash scripts/verify.sh my-thing            # run the gate, write EVIDENCE.md
bash scripts/preview.sh my-thing 8080      # click through it in a real browser
scripts/ship.sh "feat: my thing"           # verify → commit → push → open PR
```

## The verify gate (`scripts/verify.sh`)

Runs every applicable check and tees "one-look" evidence to `EVIDENCE.md` (diffstat + captured output + manual-test steps + PASS/FAIL):

- Always: `node test/run.js` — sync units, multi-tab e2e, and static load-time guards (duplicate-declaration parse, uniform `?v=`, unbumped-write scan, raw-`setValues` scan). Zero-install.
- If `apps-script-Code.gs` changed: `node --check` on a copy — paste-safety, since the backend is deployed by pasting this file.
- If a frontend file (`js/*`, `index.html`, `styles.css`) changed: `npx playwright test` — headless Chromium drives the REAL frontend against seeded demo data with no network, and captures screenshots.

CI (`.github/workflows/test.yml`) runs the same two gates on every push and PR: a dependency-free `test` job and an `e2e` job that installs Playwright + Chromium. A PR is "green at a glance" when both checks pass.

## Testing a feature in the actual website

The app renders purely from `localStorage` when `STATE.authToken` is empty (see `js/main.js` bootstrap + `js/state.js` `loadLocal`), so we seed a small demo dataset and run fully offline.

- Fixture: `test/e2e/fixtures/demo-seed.json` — a map of the app's `localStorage` keys (`cougar-data-v2`, `cougar-programs`, `cougar-filter`).
- Playwright seeds it via `context.addInitScript` before navigating (`test/e2e/support.js` → `seedAndGoto`).
- `scripts/preview.sh` serves the worktree and generates a git-ignored `__preview.html` that writes the same fixture into `localStorage`, then redirects to `index.html`. Open the printed URL and use the real app. All seed logic lives in dev/test files — never in `js/*`, so production is untouched.

Add a spec per frontend feature under `test/e2e/*.spec.js` (see `boot.spec.js` for the master-safe baseline and `training-programs.spec.js` for a feature spec).

## Pushing / deploying, one by one

The two halves of the app deploy differently — state which one a change needs.

- Frontend (`js/*`, `index.html`, `styles.css`): merge the PR, `git push`; GitHub Pages serves it.
  Bump the uniform `?v=NN` cache-buster on every frontend change (a static test enforces that all script tags + `styles.css` share one version).
  Version-bump coordination: `?v=` is a single number, so two open frontend PRs will both bump to the same `N` and the second to merge takes a trivial version-line conflict — re-bump or rebase it at merge time.
- Backend (`apps-script-Code.gs`): merge the PR(s) to `master`, then paste `master`'s `apps-script-Code.gs` into the Apps Script editor once.
  Two backend features can be separate PRs (disjoint hunks auto-merge); the deploy is a single paste of whatever `master` holds.
  A bot-only change needs just **Save**; a change to the web-app endpoints needs a **redeploy** (`/exec`).

## Why this shape

- Worktrees give true isolation: an agent can build, test, and screenshot a feature without ever touching another's files or the main checkout.
- `EVIDENCE.md` + a green CI check is the "one-look" proof a reviewer needs — captured test output, a real-browser screenshot, and exact manual-repro steps, all in the PR.
- Independent branches off `master` mean features merge in any order and roll back individually.
