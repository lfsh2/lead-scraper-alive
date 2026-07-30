// Minimal Apify REST client — no SDK dependency, uses Node 20's global fetch.
//
// One account token (APIFY_TOKEN) runs every actor. We start a run, poll it to
// completion, then page through its dataset. This is more robust than the
// run-sync endpoint (which caps at ~5 min and a limited payload) and keeps the
// whole integration dependency-free.
//
// Docs: https://docs.apify.com/api/v2

const API_BASE = "https://api.apify.com/v2";

function getToken() {
  return (process.env.APIFY_TOKEN || "").trim();
}

function isConfigured() {
  return getToken().length > 0;
}

// Actor IDs use "~" instead of "/" in REST paths:
//   curious_coder/facebook-ads-library-scraper -> curious_coder~facebook-ads-library-scraper
function toPathId(actorId) {
  return String(actorId).replace("/", "~");
}

class ApifyError extends Error {
  constructor(message, { status, actorId } = {}) {
    super(message);
    this.name = "ApifyError";
    this.status = status;
    this.actorId = actorId;
  }
}

function assertConfigured() {
  if (!isConfigured()) {
    throw new ApifyError(
      "APIFY_TOKEN is not set. Add it to your .env (and DigitalOcean env vars). " +
        "Get a free token at Apify Console → Settings → API & Integrations."
    );
  }
}

async function apiFetch(url, { method = "GET", body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* dataset items with format=json parse fine; other bodies may not */
    }
    if (!res.ok) {
      const detail =
        (json && json.error && json.error.message) ||
        (text || "").slice(0, 300) ||
        res.statusText;
      throw new ApifyError(`Apify API ${res.status}: ${detail}`, {
        status: res.status,
      });
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TERMINAL = new Set([
  "SUCCEEDED",
  "FAILED",
  "ABORTED",
  "TIMED-OUT",
  "TIMED_OUT",
]);

/**
 * Run an actor to completion and return its dataset items.
 *
 * @param {string} actorId  e.g. "curious_coder/facebook-ads-library-scraper"
 * @param {object} input    the actor's input JSON
 * @param {object} opts
 *   maxItems       cap on returned items (default 1000)
 *   maxWaitSecs    overall poll budget (default APIFY_MAX_WAIT_SECS or 300)
 *   memoryMbytes   run memory (optional)
 *   label          log label
 * @returns {Promise<object[]>} dataset items
 */
async function runActor(actorId, input = {}, opts = {}) {
  assertConfigured();
  const token = getToken();
  const label = opts.label || actorId;
  const maxItems = Number.isFinite(opts.maxItems) ? opts.maxItems : 1000;
  const maxWaitSecs =
    opts.maxWaitSecs ||
    parseInt(process.env.APIFY_MAX_WAIT_SECS || "", 10) ||
    300;

  // 1) Start the run
  const startQs = new URLSearchParams({ token });
  if (opts.memoryMbytes) startQs.set("memory", String(opts.memoryMbytes));
  const start = await apiFetch(
    `${API_BASE}/acts/${toPathId(actorId)}/runs?${startQs}`,
    { method: "POST", body: input, timeoutMs: 45000 }
  );
  const run = start && start.data;
  if (!run || !run.id) {
    throw new ApifyError(`${label}: run did not start`, { actorId });
  }
  console.log(`[Apify] ${label}: run ${run.id} started`);

  // 2) Poll until terminal
  const deadline = Date.now() + maxWaitSecs * 1000;
  let status = run.status;
  let datasetId = run.defaultDatasetId;
  let delay = 2000;
  while (!TERMINAL.has(status)) {
    if (Date.now() > deadline) {
      throw new ApifyError(
        `${label}: run ${run.id} still ${status} after ${maxWaitSecs}s ` +
          `(raise APIFY_MAX_WAIT_SECS or lower the result count)`,
        { actorId }
      );
    }
    await sleep(delay);
    delay = Math.min(delay + 1000, 8000); // gentle backoff
    const poll = await apiFetch(
      `${API_BASE}/actor-runs/${run.id}?token=${token}`
    );
    status = poll && poll.data && poll.data.status;
    datasetId = (poll && poll.data && poll.data.defaultDatasetId) || datasetId;
  }

  if (status !== "SUCCEEDED") {
    throw new ApifyError(`${label}: run ${run.id} ended ${status}`, {
      actorId,
    });
  }
  if (!datasetId) {
    throw new ApifyError(`${label}: run succeeded but has no dataset`, {
      actorId,
    });
  }

  // 3) Page through the dataset
  const items = [];
  const pageSize = 1000;
  let offset = 0;
  while (items.length < maxItems) {
    const limit = Math.min(pageSize, maxItems - items.length);
    const qs = new URLSearchParams({
      token,
      clean: "true",
      format: "json",
      offset: String(offset),
      limit: String(limit),
    });
    const batch = await apiFetch(
      `${API_BASE}/datasets/${datasetId}/items?${qs}`,
      { timeoutMs: 60000 }
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    offset += batch.length;
    if (batch.length < limit) break;
  }

  console.log(`[Apify] ${label}: ${items.length} items`);
  return items.slice(0, maxItems);
}

module.exports = { runActor, isConfigured, getToken, toPathId, ApifyError };
