// Dual-mode launcher.
//   Local dev / Mac / Linux desktop  → full `puppeteer` (auto-downloads Chrome)
//   Dockerfile (DO App Platform)     → puppeteer-core + PUPPETEER_EXECUTABLE_PATH
//   Serverless (Render, Lambda)      → puppeteer-core + @sparticuz/chromium
//
// Priority:
//   1. PUPPETEER_EXECUTABLE_PATH set  → use it directly (system Chromium in Docker)
//   2. Serverless host detected       → @sparticuz/chromium
//   3. Otherwise                      → local full puppeteer

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

    // Path 1: system Chromium (Dockerfile / explicit override)
    if (executablePathEnv) {
        const puppeteerCore = require("puppeteer-core");
        console.log("[Launcher] Using system Chromium at", executablePathEnv);
        return puppeteerCore.launch({
            executablePath: executablePathEnv,
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--single-process",
                ...extraArgs,
            ],
        });
    }

    // Path 2: serverless — use @sparticuz/chromium bundled binary
    if (isServerlessHost()) {
        const chromium = require("@sparticuz/chromium");
        const puppeteerCore = require("puppeteer-core");
        const executablePath = await chromium.executablePath();
        console.log("[Launcher] Using @sparticuz/chromium at", executablePath);
        return puppeteerCore.launch({
            args: [...chromium.args, ...extraArgs],
            defaultViewport: chromium.defaultViewport,
            executablePath,
            headless: chromium.headless,
        });
    }

    // Path 3: local dev — full puppeteer with bundled Chrome
    const puppeteer = require("puppeteer");
    return puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
            ...extraArgs,
        ],
    });
}

module.exports = { launchBrowser, isServerlessHost };
