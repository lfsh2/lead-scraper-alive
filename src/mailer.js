// Multi-provider email sender for the outreach engine.
//
// Provider is auto-selected by which credentials are present:
//   RESEND_API_KEY set            -> Resend HTTP API (best for volume + logs)
//   SMTP_URL / SMTP_HOST+USER set -> SMTP via nodemailer
//   neither                       -> "manual" (dashboard opens mailto: drafts)
//
// Resend (https://resend.com) is the recommended provider: one API key, a
// batch endpoint (up to 100/call), high deliverability, and delivery/open/
// bounce webhooks we surface in the Activity log.
//
//   RESEND_API_KEY=re_xxx
//   RESEND_FROM="Alive & Free <hello@yourdomain.com>"   (verified domain)
//
// SMTP config:
//   SMTP_URL=smtps://user:pass@smtp.host:465   (or SMTP_HOST/PORT/USER/PASS)
//   SMTP_FROM="Name <you@domain.com>"

const { getProfile } = require("./businessProfile");

const RESEND_API = "https://api.resend.com/emails";

function hasResend() {
  return !!(process.env.RESEND_API_KEY || "").trim();
}
function hasSmtp() {
  return !!(process.env.SMTP_URL || (process.env.SMTP_HOST && process.env.SMTP_USER));
}
function providerName() {
  if (hasResend()) return "resend";
  if (hasSmtp()) return "smtp";
  return "manual";
}
// Back-compat with the earlier v1 that only knew SMTP/manual.
function isSmtpConfigured() {
  return providerName() !== "manual";
}

function fromAddress() {
  if (process.env.RESEND_FROM) return process.env.RESEND_FROM;
  if (process.env.SMTP_FROM) return process.env.SMTP_FROM;
  try {
    const p = getProfile();
    const name = p.business?.name || p.owner?.name;
    const email =
      p.owner?.email || p.business?.email || process.env.OWNER_EMAIL || process.env.BUSINESS_EMAIL;
    if (email) return name ? `${name} <${email}>` : email;
  } catch { /* ignore */ }
  return process.env.OWNER_EMAIL || process.env.BUSINESS_EMAIL || "";
}

// CAN-SPAM: every commercial email needs a physical address + opt-out.
function withFooter(body) {
  if (/unsubscribe|opt.?out|reply .*stop/i.test(body)) return body;
  let addr = process.env.BUSINESS_ADDRESS || "";
  let name = "";
  try {
    const p = getProfile();
    name = p.business?.name || "";
    addr = addr || p.business?.address || "";
  } catch { /* ignore */ }
  const lines = [
    "", "—", name || "", addr || "",
    "You received this because your business was found in public listings. Reply STOP to opt out.",
  ].filter(Boolean);
  return `${body}\n${lines.join("\n")}`;
}

// ── Resend ──────────────────────────────────────────────────────────────
async function resendBatch(messages, from) {
  const payload = messages.map((m) => ({
    from,
    to: [m.to],
    subject: m.subject || "",
    text: withFooter(String(m.body || "")),
  }));
  const res = await fetch(`${RESEND_API}/batch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || `Resend ${res.status}`;
    // Whole batch failed — mark every message with the same error.
    return messages.map(() => ({ ok: false, error: String(msg) }));
  }
  const data = Array.isArray(json.data) ? json.data : [];
  return messages.map((_, i) => ({
    ok: !!(data[i] && data[i].id),
    id: data[i] && data[i].id,
    error: data[i] && data[i].id ? "" : "no id returned",
  }));
}

// ── SMTP ────────────────────────────────────────────────────────────────
let _transport = null;
function getTransport() {
  if (_transport) return _transport;
  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch {
    throw new Error("SMTP configured but 'nodemailer' isn't installed. Run: npm install nodemailer");
  }
  if (process.env.SMTP_URL) {
    _transport = nodemailer.createTransport(process.env.SMTP_URL);
  } else {
    _transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587", 10),
      secure: /^true$/i.test(process.env.SMTP_SECURE || "false"),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return _transport;
}

async function smtpSendOne(m, from) {
  const info = await getTransport().sendMail({
    from,
    to: m.to,
    subject: m.subject || "",
    text: withFooter(String(m.body || "")),
  });
  return { ok: true, id: info.messageId };
}

// ── Public API ──────────────────────────────────────────────────────────
// Send an array of {to, subject, body}. Returns results aligned to input:
//   [{ ok, id?, error? }]  (id = provider message id when available)
async function sendBatch(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const from = fromAddress();
  if (!from) return messages.map(() => ({ ok: false, error: "no from address (set RESEND_FROM/SMTP_FROM)" }));

  const provider = providerName();
  if (provider === "resend") {
    // Resend batch endpoint caps at 100 per call.
    const out = [];
    for (let i = 0; i < messages.length; i += 100) {
      out.push(...(await resendBatch(messages.slice(i, i + 100), from)));
    }
    return out;
  }
  if (provider === "smtp") {
    const out = [];
    for (const m of messages) {
      try {
        out.push(await smtpSendOne(m, from));
      } catch (e) {
        out.push({ ok: false, error: e.message });
      }
    }
    return out;
  }
  return messages.map(() => ({ ok: false, error: "no email provider configured" }));
}

// Single send convenience (used by resend-one).
async function sendMail({ to, subject, body }) {
  if (!to) throw new Error("no recipient");
  const [r] = await sendBatch([{ to, subject, body }]);
  if (!r || !r.ok) throw new Error((r && r.error) || "send failed");
  return { messageId: r.id, provider: providerName() };
}

module.exports = {
  providerName,
  isSmtpConfigured,
  sendBatch,
  sendMail,
  fromAddress,
  withFooter,
};
