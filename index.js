// Entry point.
//   - On a hosted environment (PORT or RENDER set), or when invoked with no
//     args, start the web server. This is the default for production deploys.
//   - When invoked with CLI flags (e.g. `node index.js -q "..."`), run the
//     legacy CLI.
//
// Run the CLI explicitly: `node src/cli.js …` or `npm run cli`.

const isHosted =
  !!process.env.PORT || !!process.env.RENDER || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const hasCliArgs = process.argv.slice(2).length > 0;

if (require.main === module) {
  if (isHosted || !hasCliArgs) {
    require('./src/web/server');
  } else {
    require('./src/cli').main().catch(console.error);
  }
}

module.exports = require('./src/scraper');
