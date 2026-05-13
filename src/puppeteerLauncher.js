// Dual-mode launcher.
//   Local dev / Mac / Linux desktop  → full `puppeteer` (auto-downloads Chrome)
//   Production (Render, AWS Lambda, DigitalOcean App Platform)
//                                   → `puppeteer-core` + `@sparticuz/chromium`
//
// Detection: any of these signals = production
//   RENDER=true | AWS_LAMBDA_FUNCTION_NAME | USE_SPARTICUZ_CHROMIUM=true
//   __dirname starts with /workspace  (DigitalOcean App Platform)
//
// On hosted platforms, ALSO set in env:
//   PUPPETEER_SKIP_DOWNLOAD=true   (so the install step doesn't try to fetch
//                                   Chrome — @sparticuz/chromium ships its own)

function isServerlessHost() {
    return (
        process.env.RENDER === "true" ||
        process.env.RENDER === "1" ||
        !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
        process.env.USE_SPARTICUZ_CHROMIUM === "true" ||
        __dirname.startsWith("/workspace") // DigitalOcean App Platform
    );
}

async function launchBrowser(extraArgs = []) {
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
