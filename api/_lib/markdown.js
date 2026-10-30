const STATUS_TO_LABEL = {
  saved: 'Saved',
  watched: 'Watched',
  skimmed: 'Skimmed',
};

const CATEGORY_TO_HEADING = {
  ai: 'AI',
  others: 'Others',
};

function escapeMarkdownCell(value) {
  return String(value || '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br>');
}

function resourceCell(entry) {
  const title = escapeMarkdownCell(entry.title);
  if (entry.url) {
    return `[${title}](${entry.url})`;
  }
  return title;
}

function renderCategory(entries, category) {
  const rows = entries.filter(entry => entry.category === category);
  const lines = [
    `## ${CATEGORY_TO_HEADING[category]}`,
    '',
    '| Resource | Status | Notes |',
    '|----------|--------|-------|',
  ];

  for (const entry of rows) {
    lines.push(`| ${resourceCell(entry)} | ${STATUS_TO_LABEL[entry.status] || entry.status} | ${escapeMarkdownCell(entry.notes)} |`);
  }

  if (!rows.length) {
    lines.push('|  |  |  |');
  }

  lines.push('');
  return lines.join('\n');
}

function renderMarkdown(entries) {
  const lines = [
    '# Cardlake',
    '',
    `> Last updated: ${new Date().toUTCString().replace('GMT', 'UTC')}`,
    '',
    '---',
    '',
    renderCategory(entries, 'ai'),
    renderCategory(entries, 'others'),
  ];

  return lines.join('\n').trim() + '\n';
}

module.exports = {
  renderMarkdown,
};
