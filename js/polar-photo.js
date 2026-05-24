/**
 * polar-photo.js — AI photo analyser for Cougar Data System
 * Uses simple global functions called directly from render.js HTML.
 * No patching, no observers — guaranteed to work.
 */
(function () {
  'use strict';

  const WORKER_URL = 'https://cougar-photo-proxy.isaaclj007.workers.dev';

  /* ── NOMINAL ROLL ──────────────────────────────────────────────────── */
  const FALLBACK_ROLL = {
    "C1101":"SIDDIQ MUSTAQIM BIN KAMALLUDIN","C1102":"NEO HUAN REN DAREN","C1104":"FOO HONG LIANG","C1105":"LAU ZHI JIE","C1106":"NUR IMAN SHAFIQ BIN MUHAMAD RHAIMEI","C1107":"TAN YOU JIE","C1108":"TAN JUNN SIANG, JAMES","C1109":"DANIAL IBRAHIM BIN MOHAMMAD FIRDAUS","C1110":"TAN JUAN TIN, JIREH","C1111":"LIM RUI SIANG DARREN","C1112":"LIM JOO KAI, ANSON","C1113":"SHIVAIN SHORY S/O SAWINDER KUMAR SHORY","C1114":"DYLAN CHIN YU RONG","C1115":"ISAAC HOO YU KAI","C1116":"CHOW JUN MING",
    "C1201":"CHIU KE LUN REYES","C1202":"IAN FOONG YIN HNG","C1203":"NG WEI JIE, DALSON","C1205":"KAN XIEU YONG, SHAUN","C1206":"SHAIK MUHAMMAD HAZIQ S/O ABDUL RASHID","C1207":"LEE WEN JIE","C1208":"CHOO ZI JUN JONAS","C1209":"IRFAN NUR HAQIMI BIN ZAZALI","C1210":"CEDRIC HO HONG HUNG","C1211":"RYAN NG RUI YANG","C1212":"CHIN JUN EE","C1213":"AUSTON YONG",
    "C1301":"ADAM NAUFAL BIN MOHAMMAD NAZRI","C1302":"YANG WEN KAI JOVAN","C1303":"SHAUN AARON TAN YONG SHENG","C1304":"LIM YI JIE KEITH","C1305":"CHOO JUN HAO, EDWIN","C1306":"MATTHEW NOEL ARUL","C1307":"HO MUN HOI, ZAVIER","C1308":"MUHAMMAD NORHAFIZ BIN MUHAMMAD ABDUL AZIZ","C1309":"AMOS ANG JUN LONG","C1310":"FONG QI JUN","C1311":"JUSTIN NG TIAN YU","C1312":"TAN CHIN SIANG, RYAN","C1313":"WONG WEI YIK","C1314":"DASHAN KANNA S/O VIJAYEN",
    "C1401":"ISAAC CHAU","C1402":"THAM JUN CAI","C1403":"AURELIUS POH RUI MING","C1404":"JAYDEN SIM SHENG HUAT","C1405":"LIM JIAN JIE","C1406":"BRYAN GOH","C1407":"ADEN LUCAS TAN","C1408":"KE EE JIE","C1409":"HARIS BIN HIRWAN","C1410":"MUHAMMAD ZHENG XIAN BIN ZAKARIAH","C1411":"MUHAMMAD SYABIL BIN ABDUL WAHID","C1412":"TAN HUI KAI","C1413":"ILYASAK BIN AFFANDI","C1414":"MUHAMMAD ZAFRAN BIN MOHD ZAILAN",
    "C4101":"ONG YEE HEN","C4102":"ADIL RAYYAN BIN MOHAMMAD NAZRI","C4103":"CHIA ZHENG KOON","C4104":"ALFIE STEPHEN","C4105":"GAN JIN YU","C4106":"CHAN WEN HUI","C4107":"JIAO RONGYU","C4108":"LATRELL LEE JUN YAN","C4109":"CHEW KAI XIANG, JOHN","C4110":"SEAH JIA HONG, BENJAMIN","C4111":"MUHAMMAD AKIQ BIN AZHAR","C4112":"ANG JIE EN JERON","C4114":"BRYAN TEO ZU YAO","C4115":"PRAVIN RAJENTHIRAN","C4116":"HENG JUN HAO RYAN",
    "C4201":"ANG HAN WEI","C4202":"TEDDY LIM YAN HUNG","C4203":"MERWYN FOO HE JUN","C4204":"LIM JUN YI GAVIN","C4205":"KOEN TAN DING XUN","C4206":"ETHAN POH YANG EN","C4207":"ZENG GUOZHAO LUCAS","C4208":"TORRENCE CHAN HONG KAI","C4209":"SIVARAAM SITA NAIDU","C4210":"NEO HUAN WEN ALVAN","C4211":"HAZIQ IRFAN BIN HALIM","C4212":"MUHAMMAD ZAIDAN IDRAKI BIN ROSLI","C4213":"STA MARIA KENDRICK OLIVER","C4214":"NATHANIEL CHEONG SAMAD","C4215":"LIM JIAN FENG","C4216":"DAARIS BIN NORMAL",
    "C4301":"RODERICK NEO HONG EIK","C4302":"LAU JUN JIE","C4303":"TRIVEDI PRAKHAR NILESH","C4304":"NING YI HENG, DYLAN","C4305":"MARCEL P'NG GIN","C4306":"HUI YAM HO","C4307":"TAY JIA YU BERKLY","C4308":"LIM YU HENG","C4310":"HEYRAM REDDIAR S/O RAMAMOORTHY REDDIAR","C4311":"EADRIC CHEW ZI HAO","C4312":"TAN SEE KIAT","C4313":"AXUS TAN","C4314":"SIM KAI RUI",
    "C4401":"MUHAMMAD RAYYAN ANIQ BIN ABUZAR","C4402":"WU SI YUAN JAYDEN","C4403":"TAN WON SHENG","C4405":"JOEL CHONG ZI JIAN","C4406":"MOHAMMAD RIFFAE ALFYAN BIN RAHMAT","C4407":"LIM YONG JUN","C4408":"MUHAMMAD ADYL BIN SANUSI","C4409":"ZULFADHLI BIN IDHAM","C4410":"MUHAMMAD SHAFIQ MUSTAQIM BIN MUHAMMAD","C4411":"TAI WEI DONG","C4412":"TAN ZI JIAN KENDRICK","C4413":"SHAWN KWAN WEI XIAN"
  };

  function getNominalRoll() {
    try {
      const roster = window.STATE && window.STATE.roster;
      if (roster && roster.length > 0) {
        const roll = {};
        roster.forEach(s => { if (s.id) roll[s.id.toUpperCase()] = s.name || ''; });
        return roll;
      }
    } catch (e) {}
    return FALLBACK_ROLL;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /* ── STATE ─────────────────────────────────────────────────────────── */
  let accumulated = {};
  let pendingFile = null;

  /* ── CLAUDE API ────────────────────────────────────────────────────── */
  async function analysePhoto(base64Image, mediaType) {
    const roll = getNominalRoll();
    const allIds = Object.keys(roll).sort();
    const resp = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: `You are reading a Polar fitness class summary screen from a Singapore Army unit.
Each card header starts with a 4D number like C1101 or c1101 (normalise to uppercase C + 4 digits).
The rest of the header (e.g. "S", "Daren N") is a name fragment — ignore it.
For each card extract: id (uppercase 4D), avgHR (bpm), maxHR (bpm), calories.
Valid IDs: ${allIds.join(', ')}
Only return entries whose id is in this list.
Reply ONLY with JSON, no markdown:
{"participants":[{"id":"C1101","avgHR":118,"maxHR":146,"calories":204}],"pageNote":""}`,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
          { type: 'text', text: 'Extract all participant cards.' }
        ]}]
      })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `Proxy error ${resp.status}`);
    }
    const data = await resp.json();
    const raw = (data.content || []).map(b => b.text || '').join('').trim()
      .replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    return JSON.parse(raw);
  }

  /* ── EXPORT ────────────────────────────────────────────────────────── */
  function exportToCSV(roll) {
    const rows = [['4D','Name','Avg HR (bpm)','Max HR (bpm)','Calories','Status']];
    Object.keys(roll).sort().forEach(id => {
      const d = accumulated[id];
      rows.push(d ? [id, roll[id], d.avgHR||'', d.maxHR||'', d.calories||'', 'Present']
                  : [id, roll[id], '', '', '', 'Absent']);
    });
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `polar-class-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ── MODAL ─────────────────────────────────────────────────────────── */
  function renderModal() {
    const roll = getNominalRoll();
    const presentIds = Object.keys(accumulated).sort();
    const absentIds = Object.keys(roll).sort().filter(id => !accumulated[id]);

    let html = `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:1rem;">
      <span style="font-size:12px;font-weight:600;padding:3px 10px;border-radius:20px;background:#1a3d1a;color:#6fcf6f;">${presentIds.length} present</span>
      <span style="font-size:12px;font-weight:600;padding:3px 10px;border-radius:20px;background:${absentIds.length?'#3d1a1a':'#1a3d1a'};color:${absentIds.length?'#f28b82':'#6fcf6f'};">${absentIds.length} absent</span>
      <button onclick="ppExport()" class="btn" style="margin-left:auto;font-size:12px;">⬇ Export to Excel</button>
      <button onclick="ppReset()" class="btn" style="font-size:12px;color:var(--red);">✕ Clear all</button>
    </div>`;

    if (presentIds.length) {
      html += `<div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--green);">Present (${presentIds.length})</div>
        <div style="overflow-x:auto;margin-bottom:1.25rem;"><table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="border-bottom:1px solid var(--border);">
          <th style="text-align:left;padding:6px 8px;color:var(--muted);">4D</th>
          <th style="text-align:left;padding:6px 8px;color:var(--muted);">Name</th>
          <th style="padding:6px 8px;color:var(--muted);">💓 Avg HR</th>
          <th style="padding:6px 8px;color:var(--muted);">❤️ Max HR</th>
          <th style="padding:6px 8px;color:var(--muted);">🔥 Cal</th>
        </tr></thead><tbody>`;
      presentIds.forEach(id => {
        const d = accumulated[id];
        const c = d.avgHR > 160 ? 'var(--red)' : d.avgHR > 140 ? 'var(--orange)' : 'var(--green)';
        html += `<tr style="border-bottom:0.5px solid var(--border);">
          <td style="padding:5px 8px;font-family:monospace;font-weight:700;color:var(--accent);">${id}</td>
          <td style="padding:5px 8px;">${roll[id]||''}</td>
          <td style="padding:5px 8px;text-align:center;font-weight:600;color:${c};">${d.avgHR||'—'}</td>
          <td style="padding:5px 8px;text-align:center;font-weight:600;">${d.maxHR||'—'}</td>
          <td style="padding:5px 8px;text-align:center;">${d.calories||'—'}</td>
        </tr>`;
      });
      html += `</tbody></table></div>`;
    }

    if (absentIds.length) {
      const groups = {};
      absentIds.forEach(id => { const k='Plt '+id[1]+' Sec '+id[2]; (groups[k]=groups[k]||[]).push(id); });
      html += `<div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--red);">Absent (${absentIds.length})</div>`;
      Object.entries(groups).sort().forEach(([k,ids]) => {
        html += `<div style="margin-bottom:10px;"><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px;">${k}</div>`;
        ids.forEach(id => {
          html += `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:var(--surface2);border-radius:6px;margin-bottom:3px;">
            <span style="font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;background:#3d1a1a;color:#f28b82;font-family:monospace;">${id}</span>
            <span style="font-size:12px;">${roll[id]||''}</span>
          </div>`;
        });
        html += `</div>`;
      });
    }

    document.getElementById('modal-title').textContent = `📸 Class Analysis — ${presentIds.length} present · ${absentIds.length} absent`;
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-overlay').classList.remove('hidden');
  }

  /* ── GLOBAL FUNCTIONS called from render.js HTML ───────────────────── */
  window.ppSelectFile = function(input) {
    const file = input.files[0];
    if (!file) return;
    pendingFile = file;
    const img = document.getElementById('pp-img');
    const preview = document.getElementById('pp-preview');
    const fname = document.getElementById('pp-fname');
    if (img) img.src = URL.createObjectURL(file);
    if (fname) fname.textContent = file.name;
    if (preview) preview.style.display = 'block';
    input.value = '';
  };

  window.ppDiscard = function() {
    pendingFile = null;
    const preview = document.getElementById('pp-preview');
    if (preview) preview.style.display = 'none';
  };

  window.ppAnalyse = async function() {
    if (!pendingFile) return;
    const btn = document.querySelector('[onclick="ppAnalyse()"]');
    const status = document.getElementById('pp-status');
    const viewBtn = document.getElementById('pp-view-btn');
    const counter = document.getElementById('pp-counter');
    if (btn) { btn.disabled = true; btn.textContent = 'Analysing…'; }
    if (status) { status.style.display = 'block'; status.textContent = '⏳ Sending to Claude…'; }
    try {
      const b64 = await fileToBase64(pendingFile);
      const result = await analysePhoto(b64, pendingFile.type);
      (result.participants || []).forEach(p => {
        if (p.id) accumulated[p.id.toUpperCase()] = { avgHR: p.avgHR, maxHR: p.maxHR, calories: p.calories };
      });
      const n = (result.participants || []).length;
      const total = Object.keys(accumulated).length;
      if (status) status.textContent = `✓ ${n} participants read. ${total} total loaded across all pages.`;
      if (counter) { counter.textContent = `${total} participants loaded`; counter.style.color = 'var(--green)'; }
      if (viewBtn) viewBtn.style.display = 'inline-block';
      const preview = document.getElementById('pp-preview');
      if (preview) preview.style.display = 'none';
      pendingFile = null;
    } catch(err) {
      if (status) status.textContent = '❌ Failed: ' + err.message;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Analyse this page'; }
    }
  };

  window.ppViewResults = function() { renderModal(); };

  window.ppExport = function() { exportToCSV(getNominalRoll()); };

  window.ppReset = function() {
    accumulated = {};
    const counter = document.getElementById('pp-counter');
    const viewBtn = document.getElementById('pp-view-btn');
    const status = document.getElementById('pp-status');
    if (counter) { counter.textContent = 'No pages analysed yet'; counter.style.color = ''; }
    if (viewBtn) viewBtn.style.display = 'none';
    if (status) { status.style.display = 'none'; status.textContent = ''; }
    document.getElementById('modal-overlay').classList.add('hidden');
  };

})();