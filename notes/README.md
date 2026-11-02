# Patch notes

One file per note: `notes/YYYY-MM-DD-short-slug.json`. A PR that ships a
user-visible change adds its own file here, so two open PRs never edit the
same lines and never conflict.

```json
{
  "date": "2 Nov 2026",
  "title": "One box to pick a person",
  "intro": "Optional one-line lead-in.",
  "items": [
    { "t": "▾ Tap to see everyone", "d": "Tap the box and the full list drops down." },
    "A plain string works too."
  ]
}
```

The deploy (`.github/workflows/pages.yml` → `scripts/build-site.mjs`) gathers
every file into `notes/index.json`, newest first by file name. Each phone
remembers which note ids it has seen and shows the rest once, on launch. A
phone opening the app for the first time is shown only the newest note.

`npm test` checks every file here, so a malformed note fails the PR rather
than the deploy.

The notes from before this folder existed (v106–v172) stay in
`js/patchnotes.js` as `PATCH_NOTES`, frozen.
