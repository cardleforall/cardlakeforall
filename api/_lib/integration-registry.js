// Single source of truth for what an "integration" is: an outside service
// whose items become cards in the feed after a one-time onboarding. The feed,
// the integrations API, the MCP tools and the onboarding sheet all read from
// here, so adding the next integration (Linear, Jira, ...) is a registry entry
// plus its connector code.
//
// cardType is the feed card type the integration's items are stored and
// served as. externalSource is the kanban_items.external_source value that
// marks a row as belonging to this integration. Only those rows appear in the
// feed, and only once the tenant has onboarded. `onboardingSteps` are the
// resumable steps of the setup flow; the flow is finished when the
// integration is connected (onboarded_at is set), not when a step is reached.
const INTEGRATIONS = Object.freeze({
  github_issues: Object.freeze({
    id: 'github_issues',
    name: 'GitHub Issues',
    description: 'Issues from one GitHub repository, as cards in your feed.',
    cardType: 'kanban',
    externalSource: 'github',
    onboardingSteps: Object.freeze(['intro', 'connect']),
  }),
});

const INTEGRATION_IDS = Object.freeze(Object.keys(INTEGRATIONS));

const BY_CARD_TYPE = new Map(Object.values(INTEGRATIONS).map(definition => [definition.cardType, definition]));

function getIntegrationDefinition(id) {
  return Object.prototype.hasOwnProperty.call(INTEGRATIONS, id) ? INTEGRATIONS[id] : null;
}

// The integration that owns a feed card type, or null for core types
// (reminders, learnings, ...) that are always in the feed.
function integrationForCardType(cardType) {
  return BY_CARD_TYPE.get(cardType) || null;
}

module.exports = { INTEGRATIONS, INTEGRATION_IDS, getIntegrationDefinition, integrationForCardType };
