import { checklistNotes, parseChecklist, parseFrontMatter, serializeFrontMatter, setChecklist } from './frontmatter.js';
import { localIsoMinutes, today } from './util.js';

export const objectTypes = { projects: 'project', learning: 'learning', ideas: 'idea', experiments: 'experiment' };
const defaultAreas = { project: 'projects', learning: 'learning', idea: 'ideas', experiment: 'ideas' };
export const statusOptions = {
  project: ['active', 'paused', 'done'],
  learning: ['active', 'paused', 'done'],
  idea: ['liked', 'parked', 'done'],
  experiment: ['running', 'planned', 'done'],
};

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
      } else if (area) area.push(line);
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

export function objectCard(path, markdown, config, date) {
  const folder = path.split('/')[0];
  if (!Object.hasOwn(objectTypes, folder)) return null;
  const { attributes, body } = parseFrontMatter(markdown);
  const type = objectTypes[folder];
  const { id, title, status, next_step: nextStep, last_touched: touched } = attributes;
  if (!id || !title || (attributes.type && attributes.type !== type)) return null;
  const tasks = type === 'project' ? parseChecklist(markdown) : [];
  const days = typeof touched === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(touched)
    ? (Date.parse(date) - Date.parse(touched)) / 86400000 : NaN;
  return {
    path, id, title, type, status, nextStep, attributes, body, tasks,
    taskNotes: type === 'project' ? checklistNotes(markdown) : '',
    area: attributes.area || config.defaults[type],
    progress: tasks.length ? [tasks.filter(task => task.done).length, tasks.length] : null,
    age: Number.isFinite(days) ? Math.max(0, days) : null,
  };
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

export function editStatus(markdown, type, status, date) {
  if (!statusOptions[type]?.includes(status)) throw new RangeError('Invalid object status');
  return parseFrontMatter(markdown).attributes.status === status ? markdown : updateFields(markdown, { status }, date);
}

export function journalLine(at, action, id) {
  const oneLine = value => String(value).replace(/\s+/g, ' ').trim();
  return '- ' + localIsoMinutes(at).slice(11) + ' [owner] ' + oneLine(action) + ' (' + oneLine(id) + ')';
}

export function appendJournal(markdown, line) {
  const eol = markdown.match(/\r\n|\n|\r/)?.[0] ?? '\n';
  return markdown + (markdown && !/[\r\n]$/.test(markdown) ? eol : '') + line + eol;
}

export async function saveObjectEdit(client, card, mutate, { at, description, commit }) {
  let changed;
  const result = await client.update(card.path, text => {
    const next = mutate(text, today(at));
    changed = next !== text;
    return next;
  }, 'lab: web — ' + commit);
  if (!changed) return result;
  const line = journalLine(at, description, card.id);
  let previousCount;
  const saveJournal = () => client.update('journal/' + today(at) + '.md', markdown => {
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
