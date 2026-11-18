'use strict';

function parseRobots(source, userAgent = 'SwiftlySearchBot') {
  const groups = [];
  let group = null;

  for (const rawLine of String(source || '').split(/\r?\n/)) {
    const line = rawLine.split('#', 1)[0].trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (name === 'user-agent') {
      if (!value) continue;
      if (!group || group.hasRules) {
        group = { agents: [], rules: [], delay: null, hasRules: false };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
      continue;
    }

    if (!group || !value) continue;
    if (name === 'allow' || name === 'disallow') {
      group.hasRules = true;
      group.rules.push({ allow: name === 'allow', path: value });
    } else if (name === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) group.delay = Math.min(delay, 30);
    }
  }

  const agent = userAgent.toLowerCase();
  const matching = groups
    .map((candidate) => ({
      ...candidate,
      specificity: Math.max(0, ...candidate.agents
        .filter((name) => name === '*' || agent.includes(name))
        .map((name) => (name === '*' ? 0 : name.length))),
    }))
    .filter((candidate) => candidate.agents.some((name) => name === '*' || agent.includes(name)));

  if (!matching.length) return { rules: [], crawlDelay: null };
  const specificity = Math.max(...matching.map((candidate) => candidate.specificity));
  const selected = matching.filter((candidate) => candidate.specificity === specificity);
  return {
    rules: selected.flatMap((candidate) => candidate.rules),
    crawlDelay: selected.find((candidate) => candidate.delay !== null)?.delay ?? null,
  };
}

function ruleMatches(pattern, value) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(value);
}

function canCrawl(value, robots) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const path = `${url.pathname}${url.search}`;
  let winner = null;
  let winnerSpecificity = -1;
  for (const rule of robots?.rules || []) {
    if (!rule.path || !ruleMatches(rule.path, path)) continue;
    const specificity = rule.path.replace(/[*$]/g, '').length;
    if (specificity > winnerSpecificity
      || (specificity === winnerSpecificity && rule.allow)) {
      winner = rule;
      winnerSpecificity = specificity;
    }
  }
  return winner === null || winner.allow;
}

module.exports = { canCrawl, parseRobots };
