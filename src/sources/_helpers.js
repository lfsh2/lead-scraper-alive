// Shared helpers for mapping Apify actor output into our internal lead shape.
//
// Actor output schemas vary and occasionally change, so every mapper reads
// fields defensively: `pick()` tries several candidate paths and returns the
// first non-empty value. If an actor renames a field, only the candidate list
// here needs updating — the pipeline downstream is untouched.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
const BAD_EMAIL = /noreply|no-reply|example\.com|sentry|wixpress|\.png$|\.jpg$/i;

// Read a nested path like "snapshot.body.text" off an object.
function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

// First non-empty value among candidate paths (dot-paths or direct keys).
function pick(obj, paths, fallback = "") {
  for (const p of paths) {
    const v = p.includes(".") ? getPath(obj, p) : obj[p];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return fallback;
}

function cleanEmail(raw) {
  const e = String(raw || "").trim().toLowerCase();
  if (!e || !EMAIL_RE.test(e) || BAD_EMAIL.test(e)) return "";
  return e;
}

function firstEmail(...candidates) {
  for (const c of candidates.flat()) {
    const e = cleanEmail(c);
    if (e) return e;
  }
  return "";
}

function cleanPhone(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) return "";
  return s;
}

// Facebook page URL from either an explicit URL or a numeric/handle page id.
function fbPageUrl(pageUrlOrId) {
  const v = String(pageUrlOrId || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v.split("?")[0];
  return `https://www.facebook.com/${v}`;
}

// Coerce a date-ish value (epoch seconds, epoch ms, or a string) to
// "Mon D, YYYY" to match what metaScraper produces.
function formatDate(value) {
  if (!value) return "";
  let d;
  if (typeof value === "number") {
    d = new Date(value < 1e12 ? value * 1000 : value);
  } else if (/^\d+$/.test(String(value))) {
    const n = Number(value);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else {
    d = new Date(value);
  }
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Truncate ad creative the way metaScraper does (keeps DB/creative column sane).
function truncate(str, max = 800) {
  const s = String(str || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) : s;
}

function toArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (v == null || v === "") return [];
  return [v];
}

// Dedupe an array of leads by the strongest available identity, keeping the
// first occurrence and counting how many raw rows collapsed into it.
function dedupeByIdentity(leads, keyFn) {
  const seen = new Map();
  for (const lead of leads) {
    const key = keyFn(lead);
    if (!key) {
      seen.set(Symbol(), { lead, count: 1 });
      continue;
    }
    if (seen.has(key)) {
      seen.get(key).count += 1;
    } else {
      seen.set(key, { lead, count: 1 });
    }
  }
  return Array.from(seen.values()).map(({ lead, count }) => ({
    ...lead,
    adCount: count,
  }));
}

module.exports = {
  pick,
  cleanEmail,
  firstEmail,
  cleanPhone,
  fbPageUrl,
  formatDate,
  truncate,
  toArray,
  dedupeByIdentity,
};
