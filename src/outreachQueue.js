// Background outreach send queue.
//
// Large-volume sending can't happen inside an HTTP request (timeouts, and the
// browser would hang). Instead the dashboard enqueues messages (status
// 'queued') and this in-process worker drains them in rate-limited batches,
// updating each row's status and broadcasting progress over SSE so the
// Activity log updates live.
//
// Runs in the same Node process — fine for a single-instance deploy. On boot
// any rows left 'sending' (from a crash mid-batch) are reset to 'queued'.

const mailer = require("./mailer");

let timer = null;
let running = false;

async function tick(leadsDb, broadcast, batchSize) {
  if (running) return;
  if (mailer.providerName() === "manual") return; // no server-side provider
  running = true;
  try {
    const rows = await leadsDb.getQueuedOutreach(batchSize);
    if (!rows.length) return;

    for (const r of rows) {
      await leadsDb.updateOutreachStatus(r.dedup_key, { status: "sending" });
    }

    const messages = rows.map((r) => ({
      key: r.dedup_key,
      to: r.to_email,
      subject: r.subject,
      body: r.body,
    }));

    const results = await mailer.sendBatch(messages);

    let sent = 0;
    let failed = 0;
    for (let i = 0; i < rows.length; i++) {
      const res = results[i] || { ok: false, error: "no result" };
      if (res.ok) {
        sent++;
        await leadsDb.updateOutreachStatus(rows[i].dedup_key, {
          status: "sent",
          providerId: res.id || "",
          error: "",
          sentAt: new Date().toISOString(),
        });
      } else {
        failed++;
        await leadsDb.updateOutreachStatus(rows[i].dedup_key, {
          status: "failed",
          error: res.error || "send failed",
        });
      }
    }

    if (broadcast) {
      broadcast({
        type: "outreach_progress",
        sent,
        failed,
        batch: rows.length,
        provider: mailer.providerName(),
      });
    }
    console.log(`[Queue] batch of ${rows.length}: ${sent} sent, ${failed} failed`);
  } finally {
    running = false;
  }
}

function startProcessor(leadsDb, broadcast, opts = {}) {
  if (timer) return; // already running
  const tickMs = parseInt(process.env.OUTREACH_TICK_MS || "", 10) || opts.tickMs || 3000;
  const batchSize =
    parseInt(process.env.OUTREACH_BATCH_SIZE || "", 10) || opts.batchSize || 50;

  // Recover anything stuck mid-send from a previous crash.
  Promise.resolve(leadsDb.ready)
    .then(() => leadsDb.resetSendingToQueued && leadsDb.resetSendingToQueued())
    .catch(() => {});

  timer = setInterval(
    () =>
      tick(leadsDb, broadcast, batchSize).catch((e) =>
        console.warn("[Queue] tick error:", e.message)
      ),
    tickMs
  );
  if (timer.unref) timer.unref();
  console.log(
    `[Queue] Outreach processor started (batch ${batchSize} / ${tickMs}ms, provider: ${mailer.providerName()})`
  );
}

module.exports = { startProcessor };
