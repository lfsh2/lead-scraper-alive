// Dual-mode launcher with anti-block hardening.
//   Local dev / Mac / Linux desktop  → full `puppeteer` (auto-downloads Chrome)
//   Dockerfile (DO App Platform)     → puppeteer-core + PUPPETEER_EXECUTABLE_PATH
//   Serverless (Render, Lambda)      → puppeteer-core + @sparticuz/chromium
//
// Hardening applied on EVERY path (previously only local dev had it):
//   - stealth plugin (hides navigator.webdriver et al.) when installed
//   - --disable-blink-features=AutomationControlled
//   - optional proxy via META_PROXY / PROXY_SERVER  (e.g. http://host:port)

// Stealth + puppeteer-extra are optional — degrade gracefully if absent.
let StealthPlugin = null;
let addExtra = null;
try { StealthPlugin = require("puppeteer-extra-plugin-stealth"); } catch { /* optional */ }
try { ({ addExtra } = require("puppeteer-extra")); } catch { /* optional */ }

// Wrap a base puppeteer/puppeteer-core module with the stealth plugin.
function withStealth(baseModule) {
  if (!addExtra || !StealthPlugin) return baseModule;
  try {
    const extra = addExtra(baseModule);
    extra.use(StealthPlugin());
    return extra;
  } catch {
    return baseModule;
  }
}

function proxyServer() {
  return process.env.META_PROXY || process.env.PROXY_SERVER || "";
}

// Args every launch should carry.
function commonArgs(extraArgs = []) {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-blink-features=AutomationControlled",
    ...extraArgs,
  ];
  const proxy = proxyServer();
  if (proxy) args.push(`--proxy-server=${proxy}`);
  return args;
}

function isServerlessHost() {
  return (
    process.env.RENDER === "true" ||
    process.env.RENDER === "1" ||
    !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.USE_SPARTICUZ_CHROMIUM === "true"
  );
}

async function launchBrowser(extraArgs = []) {
  const executablePathEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (proxyServer()) console.log("[Launcher] Routing through proxy", proxyServer());

  // Path 1: system Chromium (Dockerfile / explicit override)
  if (executablePathEnv) {
    const puppeteerCore = withStealth(require("puppeteer-core"));
    console.log("[Launcher] Using system Chromium at", executablePathEnv);
    return puppeteerCore.launch({
      executablePath: executablePathEnv,
      headless: true,
      // NOTE: dropped --single-process — it's documented-unstable with
      // Puppeteer and caused intermittent renderer crashes.
      args: commonArgs(extraArgs),
    });
  }

  // Path 2: serverless — @sparticuz/chromium bundled binary
  if (isServerlessHost()) {
    const chromium = require("@sparticuz/chromium");
    const puppeteerCore = withStealth(require("puppeteer-core"));
    const executablePath = await chromium.executablePath();
    console.log("[Launcher] Using @sparticuz/chromium at", executablePath);
    return puppeteerCore.launch({
      args: commonArgs([...chromium.args, ...extraArgs]),
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });
  }

  // Path 3: local dev — full puppeteer with bundled Chrome
  const puppeteer = withStealth(require("puppeteer"));
  return puppeteer.launch({
    headless: true,
    args: commonArgs(extraArgs),
  });
}

module.exports = { launchBrowser, isServerlessHost, proxyServer };
