import { checklistNotes, parseChecklist, parseFrontMatter, serializeFrontMatter, setChecklist,
  getSection, setSection } from './frontmatter.js';
import { localIsoMinutes, today } from './util.js';

export const objectTypes = { projects: 'project', learning: 'learning', ideas: 'idea', experiments: 'experiment' };
const defaultAreas = { project: 'projects', learning: 'learning', idea: 'ideas', experiment: 'ideas' };
export const statusOptions = {
  project: ['active', 'paused', 'blocked', 'done', 'dropped'],
  learning: ['active', 'paused', 'done', 'dropped'],
  idea: ['new', 'liked', 'testing', 'parked', 'done', 'killed'],
  experiment: ['planned', 'running', 'done', 'abandoned'],
};

export const commonObjectFields = ['title', 'area', 'status', 'purpose', 'next_step'];
export const typeObjectFields = {
  project: ['goal', 'blocked_by'],
  learning: ['progress', 'cadence', 'platform', 'location', 'why', 'start_date'],
  idea: ['quick_test', 'success_signal', 'main_risk'],
  experiment: ['hypothesis'],
};
export const objectPurposes = ['money', 'interest', 'learning', 'useful'];

const fields = lines => parseFrontMatter(['---', ...lines, '---'].join('\n')).attributes;

// areas.yaml uses a sequence of flat mappings and a map of type defaults.
export function parseAreas(text) {
  const areas = [];
  const defaults = [];
  let section;
  let area;
  const addArea = () => {
    if (!area) return;
    const { id, title } = fields(area);
    if (typeof id === 'string' && id && typeof title === 'string' && !areas.some(entry => entry.id === id)) {
      areas.push({ id, title });
    }
    area = undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const heading = /^([\w-]+):\s*(?:#.*)?$/.exec(line);
    if (heading) {
      addArea();
      section = heading[1];
    } else if (section === 'areas') {
      const entry = /^\s*-\s+(.*)$/.exec(line);
      if (entry) {
        addArea();
        const flow = /^\{(.*)\}\s*(?:#.*)?$/.exec(entry[1]);
        area = flow ? [...flow[1].matchAll(/(?:^|,)\s*([\w-]+)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]*)/g)]
          .map(([, key, value]) => key + ': ' + value) : [entry[1]];
      } else if (area) area.push(line.trimStart());
    } else if (section === 'defaults') {
      defaults.push(line);
    }
  }
  addArea();
  return { areas, defaults: { ...defaultAreas, ...fields(defaults) } };
}

export async function listFiles(client, directory, pattern) {
  const entries = await client.listDir(directory).catch(error => {
    if (error.status === 404) return [];
    throw error;
  });
  return entries.filter(entry => entry.type === 'file' && typeof entry.name === 'string' &&
    !/[\\/]/.test(entry.name) && pattern.test(entry.name)).map(entry => entry.name);
}


function typeFromPath(path) {
  const match = typeof path === 'string' && /^([a-z]+)\/([^/\\]+\.md)$/i.exec(path);
  return match && Object.hasOwn(objectTypes, match[1]) ? objectTypes[match[1]] : null;
}

export const isObjectPath = path => Boolean(typeFromPath(path));

function listCard(attributes, config, date) {
  const { path, id, title, status, type, next_step: nextStep, last_touched: touched,
    tasks_total: total, tasks_done: done } = attributes;
  const days = /^\d{4}-\d{2}-\d{2}$/.test(touched) ? (Date.parse(date) - Date.parse(touched)) / 86400000 : NaN;
  return {
    path, id, title, status, type, nextStep, attributes,
    area: attributes.area || config.defaults[type],
    progress: type === 'project' && Number.isInteger(total) && total > 0 ? [done ?? 0, total] : null,
    age: Number.isFinite(days) ? Math.max(0, days) : null,
  };
}

export function objectCard(path, markdown, config, date) {
  const type = typeFromPath(path);
  if (!type) return null;
  const { attributes, body } = parseFrontMatter(markdown);
  const { id, title } = attributes;
  if (!id || !title || (attributes.type && attributes.type !== type)) return null;
  const tasks = type === 'project' ? parseChecklist(markdown) : [];
  const counts = type === 'project' ? { tasks_total: tasks.length, tasks_done: tasks.filter(task => task.done).length } : {};
  return {
    ...listCard({ ...attributes, ...counts, type, path }, config, date),
    attributes, body, tasks, taskNotes: type === 'project' ? checklistNotes(markdown) : '',
  };
}

export function parseObjectIndex(text) {
  const { objects } = JSON.parse(text);
  if (!Array.isArray(objects)) throw new TypeError('Expected an object index');
  return objects.filter(entry => entry && typeof entry.id === 'string' && typeof entry.title === 'string' &&
    typeFromPath(entry.path) && typeFromPath(entry.path) === entry.type);
}

export function objectList(entries, config, date) {
  return entries.map(entry => listCard(entry, config, date))
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
}

function toIndexEntry(card) {
  const entry = { path: card.path, type: card.type, id: card.id, title: card.title };
  for (const key of ['area', 'status', 'purpose', 'origin', 'main_risk', 'next_step', 'last_touched', 'created']) {
    if (card.attributes[key] !== undefined) entry[key] = card.attributes[key];
  }
  if (card.progress) [entry.tasks_done, entry.tasks_total] = card.progress;
  else if (card.type === 'project') entry.tasks_done = entry.tasks_total = 0;
  return entry;
}

export function indexEntryFromMarkdown(path, text) {
  const card = objectCard(path, text, { defaults: defaultAreas });
  return card && toIndexEntry(card);
}

export async function loadLegacyObjectEntries(client) {
  const cards = await loadObjects(client, Object.keys(objectTypes), { defaults: defaultAreas });
  return cards.map(toIndexEntry);
}

export async function loadObjects(client, folders, config, date) {
  const paths = (await Promise.all(folders.map(async folder =>
    (await listFiles(client, folder, /^.+\.md$/i)).map(name => folder + '/' + name)))).flat();
  const cards = [];
  // Limit concurrent Contents requests even for large boards.
  for (let index = 0; index < paths.length; index += 8) {
    const batch = await Promise.all(paths.slice(index, index + 8).map(async path => {
      try {
        return objectCard(path, (await client.getFile(path)).text, config, date);
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    }));
    cards.push(...batch.filter(Boolean));
  }
  return cards.sort((a, b) => String(a.title).localeCompare(String(b.title), 'ru'));
}

// Checklist lines have no persisted IDs. Target a text occurrence from the displayed checklist.
export function taskReference(tasks, index) {
  const { text } = tasks[index];
  return { text, occurrence: tasks.slice(0, index).filter(task => task.text === text).length,
    total: tasks.filter(task => task.text === text).length };
}

function taskIndex(tasks, reference) {
  const matches = tasks.flatMap((task, index) => task.text === reference.text ? [index] : []);
  if (matches.length !== reference.total) throw new RangeError('The task list changed');
  return matches[reference.occurrence];
}

export function editChecklist(markdown, action, date) {
  const tasks = parseChecklist(markdown);
  if (action.kind === 'add') {
    const text = action.text.trim();
    if (!text) return markdown;
    tasks.push({ text, done: false });
  } else {
    const index = taskIndex(tasks, action.task);
    if (action.kind === 'tick') tasks[index].done = action.done;
    if (action.kind === 'remove') tasks.splice(index, 1);
    if (action.kind === 'up') {
      const previous = taskIndex(tasks, action.previous);
      if (index < previous) return markdown;
      if (previous !== index - 1) throw new RangeError('The task order changed');
      [tasks[previous], tasks[index]] = [tasks[index], tasks[previous]];
    }
  }
  const next = setChecklist(markdown, tasks);
  return next === markdown ? markdown : updateFields(next, { next_step: tasks.find(task => !task.done)?.text ?? '' }, date);
}

function updateFields(markdown, patch, date) {
  const document = parseFrontMatter(markdown);
  Object.assign(document.attributes, patch, { last_touched: date });
  return serializeFrontMatter(document);
}

export function objectHref(tab, path) {
  return '#' + tab + '/' + encodeURIComponent(path);
}

export function editObject(markdown, type, { fields, body, previousBody }, date) {
  const document = parseFrontMatter(markdown);
  const editable = [...commonObjectFields, ...typeObjectFields[type]];
  for (const [key, value] of Object.entries(fields)) {
    if (!editable.includes(key) || typeof value !== 'string') throw new TypeError('Invalid object field');
    if (key === 'title' && !value.trim()) throw new RangeError('Missing object title');
    if (key === 'status' && !statusOptions[type].includes(value)) throw new RangeError('Invalid object status');
    if (key === 'purpose' && value && !objectPurposes.includes(value)) throw new RangeError('Invalid object purpose');
    document.attributes[key] = value;
  }
  if (body !== undefined) {
    // Textareas normalize line endings. Keep an untouched body byte for byte and reject competing edits.
    const normalize = value => value.replace(/\r\n?/g, '\n');
    const current = normalize(document.body);
    if (current !== previousBody && current !== body) throw new RangeError('The object body changed');
    if (current !== body) {
      const eol = document.body.match(/\r\n|\n|\r/)?.[0] ?? markdown.match(/\r\n|\n|\r/)?.[0] ?? '\n';
      document.body = body.replaceAll('\n', eol);
    }
  }
  document.attributes.last_touched = date;
  return serializeFrontMatter(document);
}

export function editStatus(markdown, type, status, date) {
  if (!statusOptions[type]?.includes(status)) throw new RangeError('Invalid object status');
  return parseFrontMatter(markdown).attributes.status === status ? markdown : updateFields(markdown, { status }, date);
}

export function editIdeaComment(markdown, comment, date) {
  const text = comment.trim().replace(/\s*\r?\n\s*/g, ' ');
  if (!text) return markdown;
  const heading = 'Комментарии владельца';
  const line = '- ' + date + ': ' + text;
  const existing = getSection(markdown, heading);
  const eol = markdown.match(/\r\n|\n|\r/)?.[0] ?? '\n';
  const next = setSection(markdown, heading, existing ? line + eol + existing : line);
  return updateFields(next, {}, date);
}

export function journalLine(at, action, id) {
  const oneLine = value => String(value).replace(/\s+/g, ' ').trim();
  return '- ' + localIsoMinutes(at).slice(11) + ' [owner] ' + oneLine(action) + ' (' + oneLine(id) + ')';
}

export function appendJournal(markdown, line) {
  const eol = markdown.match(/\r\n|\n|\r/)?.[0] ?? '\n';
  return markdown + (markdown && !/[\r\n]$/.test(markdown) ? eol : '') + line + eol;
}

export async function saveObjectEdit(client, card, mutate, { at, day = today(at), description, commit }) {
  let changed;
  const result = await client.update(card.path, text => {
    const next = mutate(text, day);
    changed = next !== text;
    return next;
  }, 'lab: web — ' + commit);
  if (!changed) return result;
  const line = journalLine(at, description, card.id);
  let previousCount;
  const saveJournal = () => client.update('journal/' + day + '.md', markdown => {
    const count = markdown.split(/\r\n|\n|\r/).filter(entry => entry === line).length;
    previousCount ??= count;
    return count > previousCount ? markdown : appendJournal(markdown, line);
  }, 'lab: web — journal ' + commit, { initial: '' });
  try {
    await saveJournal();
    return result;
  } catch {
    return { ...result, saveJournal };
  }
}
