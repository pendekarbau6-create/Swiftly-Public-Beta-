'use strict';

/**
 * Command line harness for the Swiftly search engine.
 *
 *   node src/search/standalone.js "your query"
 *   node src/search/standalone.js --suggest "your quer"
 *   node src/search/standalone.js --status
 */

const engine = require('./engine');
const { suggest } = require('./suggest');
const { instantAnswer } = require('./instant');

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, query: positional.join(' ') };
}

function printResults(payload) {
  console.log(`\n  "${payload.query}"  —  ${payload.results.length} results via ${payload.provider} (${payload.took}ms)\n`);

  if (payload.instant) {
    console.log(`  [${payload.instant.kind}] ${payload.instant.title}`);
    if (payload.instant.detail) console.log(`         ${payload.instant.detail}`);
    console.log('');
  }

  if (payload.knowledge) {
    console.log(`  [knowledge] ${payload.knowledge.title} — ${payload.knowledge.description}`);
    console.log(`         ${String(payload.knowledge.extract).slice(0, 160)}…`);
    console.log('');
  }

  payload.results.forEach((result, index) => {
    console.log(`  ${String(index + 1).padStart(2)}. ${result.title}`);
    console.log(`      ${result.url}`);
    console.log(`      ${String(result.snippet).slice(0, 150)}${result.snippet.length > 150 ? '…' : ''}`);
    console.log('');
  });

  if (payload.related.length) {
    console.log(`  Related: ${payload.related.map((r) => r.title).join(', ')}\n`);
  }

  if (payload.failures?.length) {
    console.log(`  Provider failures: ${payload.failures.map((f) => `${f.provider} (${f.reason})`).join(', ')}\n`);
  }
}

async function main() {
  const { flags, query } = parseArgs(process.argv);

  if (flags.status) {
    console.log(JSON.stringify(engine.status(), null, 2));
    return;
  }

  if (flags.suggest) {
    const items = await suggest(flags.suggest === true ? '' : flags.suggest);
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  if (flags.instant) {
    const answer = await instantAnswer(flags.instant === true ? '' : flags.instant);
    console.log(JSON.stringify(answer, null, 2));
    return;
  }

  if (!query) {
    console.log('Usage: node src/search/standalone.js "<query>" | --suggest "<partial>" | --status');
    return;
  }

  const payload = await engine.search(query, {
    limit: Number(flags.limit) || 10,
    safeSearch: flags.safe || 'moderate',
  });
  printResults(payload);
}

main().catch((error) => {
  console.error('Search failed:', error);
  process.exit(1);
});
