// Google Forms profile source. Pure helpers; raw NRICs never enter a report.
import { nameKey, parseCsv, nricKey } from "./intake-plan.mjs";
import { toISO } from "./intake-plan.mjs";
import { bigramSimilarity, rankScore } from "./reseat-plan.mjs";

const canonicalHeader = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const HEADERS = [
  ["fullnameasperbirth", "name"], ["nric", "nric"], ["platoon", "plt"],
  ["mobilenumber", "phone"], ["emailaddress", "email"], ["dateofbirth", "dob"],
  ["heightcm", "height"], ["weightkg", "weight"], ["whatisyourbloodtype", "bloodType"],
  ["highesteducationlevel", "highest education level"], ["doyouhaveamotorbike", "motorcycle license"],
  ["othermedicalconditions", "otherMedical"], ["rationtype", "ration"], ["drugfoodallergies", "allergies"],
  ["fullnameofnok", "nokName"], ["relationshiptonok", "nokRelation"], ["nokmobilenumber", "nokPhone"],
  ["residentialaddress", "address"],
];
export function profileValue(field, value) {
  let s=String(value ?? "").trim().replace(/\s+/g," ").toLowerCase();
  if (field==="dob") return toISO(s) || s;
  if (["phone","nokPhone"].includes(field)) {
    if (!/^[+0-9\s().-]*$/.test(s)) return s;
    const digits=s.replace(/[^0-9]/g,"");
    return digits.length===10 && digits.startsWith("65") ? digits.slice(2) : digits;
  }
  if (["height","weight"].includes(field)) {
    s=s.replace(/\s*(cm|kg)$/i,"");
    return /^\d+(\.\d+)?$/.test(s) ? String(Number(s)) : s;
  }
  if (["otherMedical","allergies"].includes(field) && ["","nil","none","no","n/a","na"].includes(s)) return "";
  return s;
}
export function formDob(value) {
  const s=String(value ?? "").trim();
  const match=s.match(/^(\d{2})(\d{2})(\d{4})$/) || s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [,d,m,y]=match, date=new Date(Date.UTC(+y,+m-1,+d));
  if (date.getUTCFullYear()!==+y || date.getUTCMonth()!==+m-1 || date.getUTCDate()!==+d || +y<1900 || +y>new Date().getFullYear()) return null;
  return `${+d} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m-1]} ${y}`;
}
export function parseForms(text, hash) {
  return parseCsv(text).map((raw,n) => {
    const values={};
    for (const [header,value] of Object.entries(raw)) {
      const key=canonicalHeader(header), field=HEADERS.find(([prefix])=>key.startsWith(prefix))?.[1];
      if (field) values[field]=String(value ?? "").trim();
    }
    const name=values.name;
    const nk=nricKey(values.nric);
    const nricHash=nk ? hash(`nric:${nk}`) : "";
    delete values.nric; delete values.name; delete values.plt;
    const issues=[];
    if (values.dob) {
      const dob=formDob(values.dob);
      if (!dob) issues.push("DOB requires verification: not a valid DDMMYYYY or DD/MM/YYYY date");
      else values.dob=dob;
    }
    return { line:n+2, name, nricHash, fields:values, issues };
  });
}

export function matchForms(person, forms) {
  const candidates=forms.map(f=>({
    form:f, score:Math.max(bigramSimilarity(person.name,f.name),rankScore(person.name,f.name)),
    exact:nameKey(person.name)===nameKey(f.name), nric:!!person.nricHash && person.nricHash===f.nricHash,
  })).sort((a,b)=>Number(b.nric)-Number(a.nric)||Number(b.exact)-Number(a.exact)||b.score-a.score);
  const digests=candidates.filter(c=>c.nric), exact=candidates.filter(c=>c.exact);
  let chosen=null, method=null;
  if (digests.length===1) { chosen=digests[0];method="nric"; }
  else if (!digests.length && exact.length===1) {
    const c=exact[0];
    if (!(person.nricHash && c.form.nricHash && person.nricHash!==c.form.nricHash)) {chosen=c;method="exact-name";}
  }
  // Fuzzy matches are ranked for review; a fuzzy name alone cannot establish
  // whose address, next-of-kin or medical details should be written.
  return { matched:!!chosen, method, form:chosen?.form ?? null,
    candidates:candidates.slice(0,3).map(c=>({line:c.form.line,name:c.form.name,score:c.score,exact:c.exact,nric:c.nric})),
    issues:chosen ? chosen.form.issues : ["Name match requires review; no unique corroborated match"],
  };
}
