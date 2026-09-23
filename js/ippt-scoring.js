// Singapore Armed Forces IPPT scoring tables (servicemen, 3-station IPPT).
//
// Encoding strategy: encode age group 1 (<22) explicitly for each station,
// then derive every other age group by applying a per-group shift — push-ups
// and sit-ups shift by 1 rep per age group (older = needs fewer reps for the
// same score); 2.4km run shifts by 10 seconds per age group (older = more
// time allowed).
//
// Verified, not assumed: age groups 1 and 2 reproduce every one of the 680
// BMT results (26 May - 13 Aug 2026) that has a real run time, point for
// point, against the printed totals on the official score sheets. The static
// tables are the MINDEF "Sit-Up/Push-Up Score Table for Servicemen". Older
// age groups rely on the shift rule alone and have never been checked against
// a sheet. The score is pre-filled in the IPPT form but stays editable.
//
// Award tiers per user request:
//   ≥90: Gold★ (NDU / Commando / Guards quality)
//   ≥85: Gold
//   ≥75: Silver
//   ≥61: Pass
//   <61: Fail (or N/A if 0)

// Map an age in years to its IPPT age group (1-14). Returns 0 when age is
// missing or out of range — caller falls back to manual score entry.
function ageGroupForIPPT(age) {
  const a = +age;
  if (!a) return 0;
  if (a < 22) return 1;
  if (a <= 24) return 2;
  if (a <= 27) return 3;
  if (a <= 30) return 4;
  if (a <= 33) return 5;
  if (a <= 36) return 6;
  if (a <= 39) return 7;
  if (a <= 42) return 8;
  if (a <= 45) return 9;
  if (a <= 48) return 10;
  if (a <= 51) return 11;
  if (a <= 54) return 12;
  if (a <= 57) return 13;
  if (a <= 60) return 14;
  return 0;
}

const IPPT_AGE_LABELS = ["<22","22-24","25-27","28-30","31-33","34-36","37-39","40-42","43-45","46-48","49-51","52-54","55-57","58-60"];

// Push-up scoring for age group 1 (<22). Key = reps; value = score.
// Reps below 14 = 0; reps ≥ 60 = 25 (capped).
const PUSHUP_GROUP1 = {
  60:25, 59:24, 58:24, 57:24, 56:24,
  55:23, 54:23, 53:23, 52:23,
  51:22, 50:22, 49:22, 48:22,
  47:21, 46:21, 45:21, 44:21,
  43:20, 42:20, 41:20, 40:20,
  39:19, 38:19, 37:19,
  36:18, 35:18, 34:18,
  33:17, 32:17, 31:17,
  30:16, 29:16, 28:16,
  27:15, 26:15,
  25:14, 24:13, 23:12, 22:11, 21:10, 20:9, 19:8,
  18:6, 17:4, 16:2, 15:1, 14:0
};

// Sit-up scoring for age group 1 (<22). NOT the push-up table: sit-ups score
// lower from 37 reps down (37 = 18, 30 = 13, 25 = 9). An earlier copy of this
// table was the push-up table pasted in, which over-scored a 30-rep sit-up by
// 3 points.
const SITUP_GROUP1 = {
  60:25, 59:24, 58:24, 57:24, 56:24,
  55:23, 54:23, 53:23, 52:23,
  51:22, 50:22, 49:22, 48:22,
  47:21, 46:21, 45:21, 44:21,
  43:20, 42:20, 41:20, 40:20,
  39:19, 38:19,
  37:18, 36:18,
  35:17, 34:16, 33:15, 32:14, 31:14,
  30:13, 29:13, 28:12, 27:11, 26:10,
  25:9, 24:8, 23:7, 22:7, 21:6, 20:6, 19:5,
  18:4, 17:3, 16:2, 15:1, 14:0
};

// 2.4km run scoring for age group 1 (<22). Key = the SLOWEST time (seconds)
// that still earns the score: 8:30 or faster = 50, 8:31-8:40 = 49, and so on.
// Slower than 16:00 (960s) = 0.
const RUN_GROUP1 = {
  510:50, 520:49, 530:48, 540:47, 550:46, 560:45, 570:44, 580:43, 590:42, 600:41,
  610:40, 620:39, 630:38, 640:38, 650:37, 660:37, 670:36, 680:36, 690:35, 700:35,
  710:34, 720:33, 730:32, 740:31, 750:30, 760:29, 770:28, 780:27, 790:26, 800:25,
  810:24, 820:23, 830:22, 840:21, 850:20, 860:19, 870:18, 880:16, 890:14, 900:12,
  910:10, 920:8, 930:6, 940:4, 950:2, 960:1, 970:0
};

// Look up rep-based score with the 1-rep-per-age-group shift. Higher age
// group = same score with fewer reps, so we add (ageGroup-1) to reps to
// translate into the group-1 reference frame, then look up.
function lookupRepScore(table, reps, ageGroup) {
  if (!ageGroup) return null;
  const r = Math.max(0, +reps || 0);
  const adj = r + (ageGroup - 1);
  if (adj >= 60) return 25;
  if (adj < 14) return 0;
  return table[adj] !== undefined ? table[adj] : 0;
}

// Parse "mm:ss" (e.g. "10:45") into total seconds. Returns null on bad input.
function parseRunTimeMMSS(mmss) {
  if (mmss == null) return null;
  const m = String(mmss).trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  return +m[1] * 60 + +m[2];
}

// Look up run score with the 10-sec-per-age-group shift. Higher age group
// = same score with slower allowed time, so we subtract (ageGroup-1)*10s
// from the actual seconds to translate into the group-1 reference frame.
function lookupRunScore(seconds, ageGroup) {
  if (!ageGroup || seconds == null) return null;
  // 0:00 is how a result with no run is stored, not a record-breaking run.
  if (seconds <= 0) return 0;
  const adjSec = seconds - (ageGroup - 1) * 10;
  if (adjSec <= 510) return 50;
  if (adjSec > 960) return 0;
  // Each band ends ON its key, so round UP to the band's upper bound: 12:02 is
  // in the 12:01-12:10 band (32 pts). Math.round put it in 11:51-12:00 (33).
  const key = Math.ceil(adjSec / 10) * 10;
  return RUN_GROUP1[key] !== undefined ? RUN_GROUP1[key] : 0;
}

// Top-level entry point used by the IPPT form. Returns:
//   { ageGroup, pushupScore, situpScore, runScore, total, award }
// or null when age is missing/invalid (caller should fall back to manual
// score entry).
function calculateIPPTScore(age, pushups, situps, runTimeMMSS) {
  const ag = ageGroupForIPPT(age);
  if (!ag) return null;
  const pushupScore = lookupRepScore(PUSHUP_GROUP1, pushups, ag);
  const situpScore = lookupRepScore(SITUP_GROUP1, situps, ag);
  const runSec = parseRunTimeMMSS(runTimeMMSS);
  const runScore = runSec != null ? lookupRunScore(runSec, ag) : null;
  if (pushupScore == null || situpScore == null || runScore == null) return null;
  const total = pushupScore + situpScore + runScore;
  return {
    ageGroup: ag,
    ageLabel: IPPT_AGE_LABELS[ag - 1] || "",
    pushupScore, situpScore, runScore,
    total,
    award: ipptAward(total)
  };
}

// Award tier, including the 90+ NDU/Commando/Guards distinction. Used by
// both getAward() in helpers.js and the live form breakdown.
function ipptAward(score) {
  const s = +score || 0;
  if (s >= 90) return "Gold★";
  if (s >= 85) return "Gold";
  if (s >= 75) return "Silver";
  if (s >= 61) return "Pass";
  if (s > 0) return "Fail";
  return "N/A";
}

// Badge color hint for the award; used by helpers' badge() / awardBadge().
function ipptAwardColor(award) {
  if (award === "Gold★") return "purple";  // distinct from regular gold
  if (award === "Gold") return "orange";
  if (award === "Silver") return "muted";
  if (award === "Pass") return "green";
  if (award === "Fail") return "red";
  return "muted";
}
