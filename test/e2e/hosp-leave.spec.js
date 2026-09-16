// Feature spec for the Hospitalisation Leave medical status.
//
// The status means an MO has given the man leave following treatment: he is
// away from camp and, unlike an ordinary MC, cannot come in to endorse it. So
// the two things this spec proves in a real browser are that it is SELECTABLE
// like any other medical status, and that once logged it is counted away
// everywhere the app already counts an MC away - while still printing as its
// own classification on the parade state rather than as an MC.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

const HOSP = "Hospitalisation Leave";

test.describe("Hospitalisation Leave", () => {
  test("is selectable in Report Sick, and offers no consume-in-camp option", async ({ page }) => {
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await seedAndGoto(page);

    await page.evaluate(() => openMedicalForm());
    const opt = page.locator('#f-status option', { hasText: HOSP });
    await expect(opt).toHaveCount(1);

    // It belongs with the away-from-camp statuses, not with the excuses.
    const group = await page.evaluate(h =>
      [...document.querySelectorAll("#f-status optgroup")]
        .find(g => [...g.children].some(o => o.value === h))?.label,
    HOSP);
    expect(group).toBe("Severe (away from camp)");

    // MC offers "Consume in camp"; Hospitalisation Leave must not, because the
    // whole point of it is that the man cannot come in.
    await page.selectOption("#f-status", "MC");
    await expect(page.locator("#f-incamp-wrap")).toBeVisible();
    await page.selectOption("#f-status", HOSP);
    await expect(page.locator("#f-incamp-wrap")).toBeHidden();

    expect(errors, "no page errors: " + errors.join("; ")).toEqual([]);
  });

  test("counts the man out of camp and files its own ATT C parade line", async ({ page }) => {
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await seedAndGoto(page);

    const parade = await page.evaluate(h => {
      const iso = todayISO();
      const disp = isoToDisplayDate(iso);
      const end = isoToDisplayDate(nextDayISO(nextDayISO(iso)));
      // 1401: an ordinary away MC, for the side-by-side comparison.
      STATE.medical.push({ id: nextId(), d4: "1401", date: disp, reason: "Conjunctivitis",
        status: "MC", startDate: disp, endDate: disp, inCamp: false });
      // 1402: hospitalisation leave, three days.
      STATE.medical.push({ id: nextId(), d4: "1402", date: disp, reason: "Post-op",
        status: h, startDate: disp, endDate: end, inCamp: false });
      saveLocal(); render();
      return generateParadeStateText("FP", iso, "0730");
    }, HOSP);

    // Its own classification under ATT C, alongside the MC - never "MC".
    const lines = parade.split("\n").filter(l => /^\d+\. (1401|1402) /.test(l));
    expect(lines.some(l => /^\d+\. 1401 .* - 1D MC \(Conjunctivitis\) \(\d{6}\)$/.test(l)),
      "the MC line is unchanged: " + lines).toBeTruthy();
    expect(lines.some(l => /^\d+\. 1402 .* - 3D HOSP LEAVE \(Post-op\) \(\d{6}-\d{6}\)$/.test(l)),
      "hosp leave files as its own classification: " + lines).toBeTruthy();
    // Both bodies are away: 6 recruits + 1 commander, 2 out.
    expect(parade).toContain("COMPANY: 5/7");

    // The roster Camp column reads the SHARED out-of-camp map, so it has to
    // agree without any code of its own.
    await page.click('.nav-btn[data-nav="roster"]');
    const row = await page.evaluate(() => {
      const tr = [...document.querySelectorAll("table tbody tr")].find(r => r.textContent.includes("1402"));
      const tds = [...tr.querySelectorAll("td")];
      return { status: tds[3]?.innerText.trim(), camp: tds[4]?.innerText.trim() };
    });
    expect(row.camp).toContain("Medical");
    // The badge shows the phone-width shorthand, not the full 21-character name.
    expect(row.status).toContain("HOSP LEAVE");

    await page.screenshot({ path: "test-results/hosp-leave.png", fullPage: true });
    expect(errors, "no page errors: " + errors.join("; ")).toEqual([]);
  });
});
