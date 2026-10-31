// The command line every *_scenarios.js file shares:
//   node tests/unit/<file> <name>   runs one scenario, in a fresh process
//   node tests/unit/<file> --list   prints every scenario name, one per line
// Exit codes: 0 passed, 1 failed, 2 unknown name. --list is how
// test_suite_wiring.py checks that each scenario is run by a test_*.py.
'use strict';

function runScenario(scenarios, name = process.argv[2]) {
  if (name === '--list') {
    process.stdout.write(`${Object.keys(scenarios).join('\n')}\n`);
    process.exit(0);
  }
  if (typeof scenarios[name] !== 'function') {
    console.error(`Unknown scenario "${name}". Known: ${Object.keys(scenarios).join(', ')}`);
    process.exit(2);
  }
  Promise.resolve()
    .then(() => scenarios[name]())
    .then(() => process.exit(0), error => { console.error(error.stack || error); process.exit(1); });
}

module.exports = { runScenario };
