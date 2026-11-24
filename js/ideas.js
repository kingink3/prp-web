export const ideaFilterStatuses = ['all', 'new', 'liked', 'testing', 'parked', 'done', 'killed'];

export function ideaStatus(status) {
  if (status === 'paused') return 'parked';
  if (status === 'dropped') return 'killed';
  return status || 'new';
}

export function ideaList(cards, area, filter) {
  const ideas = cards.filter(card => card.type === 'idea' && (!area || card.area === area));
  const counts = Object.fromEntries(ideaFilterStatuses.map(status => [status, 0]));
  const visible = [];
  for (const card of ideas) {
    const status = ideaStatus(card.status);
    if (Object.hasOwn(counts, status) && status !== 'all') counts[status]++;
    if (status !== 'killed') counts.all++;
    if (filter === 'all' ? status !== 'killed' : status === filter) visible.push(card);
  }
  const touched = card => String(card.attributes.last_touched || card.attributes.created || '');
  visible.sort((a, b) => touched(b).localeCompare(touched(a)));
  return { counts, visible };
}
