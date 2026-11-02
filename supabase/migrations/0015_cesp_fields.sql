-- ============================================================================
-- 0015_cesp_fields.sql - PES, latest SOC and THT weapons as roster columns
--
-- The CESP badge needs four facts per man that the roster did not hold:
--   pes           PES grade ("A", "B1", "B2", "E1"...)
--   socLevel      latest SOC passed ("SOC1".."SOC5", "None" = never did one)
--   thtPrimary    THT-trained primary weapon ("MATADOR", "LMG", "M203", "")
--   thtSecondary  THT-trained secondary weapon
-- CPR/AED and the basic drone package are ordinary qualifications and stay in
-- extra.quals with the rest; they need no column.
--
-- Plain text, not encrypted: a PES grade is the same class of fact as the
-- medical status rows, which are not encrypted either, and the parade state
-- already prints it. Additive and safe to run on a populated roster.
--
-- WHY THE EXTRA CLEAN-UP
-- ----------------------
-- api_row() lays `extra` OVER the real columns. A phone running the new
-- frontend before this migration (or before the Edge Function's column cache
-- refreshes) sends these keys, and shapeRow parks them in `extra`, often as
-- "". Left there, that stale "" would mask the real column forever. So any
-- value already in extra is moved into the column, and the key is removed.
--
-- DEPLOY ORDER: apply this, redeploy the Edge Function (its columnsOf cache is
-- per warm instance and would keep routing these keys to extra), THEN merge
-- the frontend.
-- ============================================================================

alter table roster
  add column if not exists "pes"          text,
  add column if not exists "socLevel"     text,
  add column if not exists "thtPrimary"   text,
  add column if not exists "thtSecondary" text;

update roster set
  "pes"          = coalesce(nullif("pes", ''),          nullif(extra ->> 'pes', '')),
  "socLevel"     = coalesce(nullif("socLevel", ''),     nullif(extra ->> 'socLevel', '')),
  "thtPrimary"   = coalesce(nullif("thtPrimary", ''),   nullif(extra ->> 'thtPrimary', '')),
  "thtSecondary" = coalesce(nullif("thtSecondary", ''), nullif(extra ->> 'thtSecondary', '')),
  extra = extra - 'pes' - 'socLevel' - 'thtPrimary' - 'thtSecondary'
where extra ?| array['pes', 'socLevel', 'thtPrimary', 'thtSecondary'];
