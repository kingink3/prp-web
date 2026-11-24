import { isDay } from './history.js';
import { getSection, parseFrontMatter, serializeFrontMatter, setSection } from './frontmatter.js';
import { addObjectToPlan, focusOrder, planGroups, planPath, referencePath, uniqueId } from './today-data.js';
import { eveningDate, localIsoMinutes, postponedId, tomorrow } from './util.js';

export const resumeSection = 'Где остановился';
const testMinutes = 45;
const activeExperiments = new Set(['planned', 'running']);
const closed = new Set(['done', 'dropped', 'abandoned']);
const resumeKinds = new Set(['project', 'learning', 'experiment']);
const ideaId = idea => idea.id ?? idea.ref;
const minutes = items => items.reduce((total, item) => total + (item.minutes ?? 0), 0);

export function isEvening(at) {
  return at.getHours() >= 22 || at.getHours() < 4;
}

export function nextPlanDay(date) {
  return tomorrow(new Date(date + 'T12:00'));
}

function counts(items) {
  const done = items.filter(item => item.done);
  return { done: done.length, total: items.length, elapsed: minutes(done), planned: minutes(items),
    spent: done.reduce((total, item) => total + (item.spent ?? 0), 0) };
}

function dated(at, date) {
  if (!at) return false;
  const parsed = new Date(at);
  return Number.isFinite(parsed.getTime()) && eveningDate(parsed) === date;
}

function choice(entry, duration) {
  return { ref: entry.id, kind: entry.type, title: entry.title,
    task: entry.next_step || entry.quick_test || entry.title, minutes: duration };
}

export function stepModel(plan, todos, tasks, objects, previous, kept = new Set()) {
  const items = plan.items ?? [];
  const statuses = new Map(objects.map(entry => [entry.id, entry.status]));
  const groups = planGroups({ items }, { todos }, statuses);
  const open = items.filter(item => !item.done);
  const planned = new Set(open.map(item => item.ref));
  const stats = counts(items);
  const ideas = plan.ideas ?? [];
  const waiting = ideas.filter(idea => !idea.reaction);
  const projects = objects.filter(entry => entry.type === 'project' && entry.status === 'active' && entry.next_step)
    .map(entry => choice(entry, 30));
  const candidates = new Map();
  for (const entry of [...(plan.candidates ?? []), ...projects]) {
    const path = referencePath(entry.ref);
    const kind = entry.kind ?? entry.ref?.split('-')[0];
    if (!path || !['project', 'experiment'].includes(kind) || planned.has(entry.ref) || candidates.has(entry.ref)) continue;
    candidates.set(entry.ref, { ...entry, kind, task: entry.task || entry.next_step || entry.title,
      minutes: entry.minutes ?? 30 });
  }
  const experiments = objects.filter(entry => entry.type === 'experiment');
  const activeTests = experiments.filter(entry => activeExperiments.has(entry.status))
    .map(entry => choice(entry, testMinutes));
  const tested = new Set(experiments.map(entry => entry.idea).filter(Boolean));
  const morningTests = [...activeTests, ...objects.filter(entry =>
    entry.type === 'idea' && entry.status === 'testing' && !tested.has(entry.id)).map(entry => choice(entry, testMinutes))]
    .filter(entry => !planned.has(entry.ref));
  const tomorrowDate = nextPlanDay(plan.date);
  const postponed = (plan.postponed ?? []).filter(item => item.until === tomorrowDate);
  const scheduled = new Set(postponed.map(item => item.ref));
  const objectsById = new Map(objects.map(entry => [entry.id, entry]));
  const eveningTests = [...activeTests];
  for (const idea of ideas.filter(entry => ['test', '🧪'].includes(entry.reaction))) {
    const ref = ideaId(idea);
    if (referencePath(ref)?.startsWith('ideas/')) {
      eveningTests.push(choice({ ...objectsById.get(ref), id: ref, type: 'idea',
        title: idea.title ?? objectsById.get(ref)?.title ?? ref }, testMinutes));
    }
  }
  const notes = new Map((plan.evening?.notes ?? []).map(note => [note.ref, note.text]));
  const refs = [...new Set(items.map(item => item.ref))].map(ref => objectsById.get(ref)).filter(entry =>
    entry && resumeKinds.has(entry.type) && !closed.has(entry.status) && entry.resume !== false &&
    referencePath(entry.id)).map(entry => ({ ...entry, note: notes.get(entry.id) ?? '' }));

  return {
    previous: previous && { ...counts(previous.items ?? []), date: previous.date,
      postponed: (previous.postponed ?? []).filter(item => !item.postponed_on || item.postponed_on === previous.date).length },
    stats, budget: plan.budget_minutes ?? 0, open, waiting, learningMinutes: minutes(items.filter(item => item.kind === 'learning')),
    review: tasks.filter(task => ['review', 'changes'].includes(task?.status)).length,
    ready: tasks.filter(task => task?.status === 'ready').length,
    tails: open.filter(item => (item.carried || item.blocker?.trim()) && !kept.has(item.id)),
    candidates: [...candidates.values()], morningTests,
    codex: tasks.filter(task => ['ready', 'changes'].includes(task?.status)),
    first: focusOrder(groups)[0]?.item,
    groupCounts: Object.fromEntries(Object.entries(groups).map(([key, rows]) =>
      [key, counts(rows.filter(row => row.path === planPath).map(row => row.item))])),
    doneTodos: todos.filter(item => item.done && dated(item.done_at, plan.date)).length,
    merged: tasks.filter(task => task?.status === 'merged' && dated(task.updated, plan.date)).length,
    refs, eveningTests: eveningTests.filter(entry => !scheduled.has(entry.ref)),
    draft: { date: tomorrowDate, postponed, planned: minutes(postponed), projects },
    doneAt: plan.evening?.done_at,
  };
}

export async function previousPlan(lab, date) {
  if (!isDay(date)) return null;
  const indexed = lab.peekHistoryDates()?.find(day => day < date);
  const target = new Date(date + 'T12:00Z');
  const recent = Array.from({ length: 7 }, () => {
    target.setUTCDate(target.getUTCDate() - 1);
    return target.toISOString().slice(0, 10);
  });
  for (const day of new Set(indexed ? [indexed, ...recent] : recent)) {
    try {
      const path = 'history/' + day + '.json';
      const { text } = lab.peek(path) ?? await lab.refresh(path);
      return { ...JSON.parse(text), date: day };
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return null;
}

export function pickCandidate(plan, entry, at) {
  if ((plan.items ?? []).some(item => !item.done && item.ref === entry.ref)) return plan;
  return addObjectToPlan(plan, { id: entry.ref, type: entry.kind, title: entry.title,
    nextStep: entry.task, minutes: entry.minutes }, at);
}

export function scheduleTest(plan, entry, at) {
  const postponed = plan.postponed ?? [];
  const until = nextPlanDay(plan.date);
  if (postponed.some(item => item.ref === entry.ref && item.until === until)) return plan;
  const id = uniqueId([...(plan.items ?? []), ...postponed], postponedId(at));
  return { ...plan, postponed: [...postponed, {
    id, ref: entry.ref, kind: entry.kind, title: entry.title, task: entry.task, minutes: testMinutes,
    done: false, done_at: null, until, postponed_on: plan.date,
  }] };
}

export function saveEveningNote(plan, ref, text) {
  const notes = plan.evening?.notes ?? [];
  if (notes.some(note => note.ref === ref && note.text === text)) return plan;
  return { ...plan, evening: { ...plan.evening, notes: [...notes.filter(note => note.ref !== ref), { ref, text }] } };
}

export function writeResumeNote(markdown, text, date) {
  const document = parseFrontMatter(markdown);
  if (document.attributes.resume === false || closed.has(document.attributes.status)) {
    throw new RangeError('The object no longer accepts resume notes');
  }
  if (getSection(markdown, resumeSection) === text && document.attributes.last_touched === date) return markdown;
  const updated = parseFrontMatter(setSection(markdown, resumeSection, text));
  updated.attributes.last_touched = date;
  return serializeFrontMatter(updated);
}

export function completeEvening(plan, at) {
  if (plan.evening?.done_at) return plan;
  return { ...plan, evening: { ...plan.evening, done_at: localIsoMinutes(at) } };
}
