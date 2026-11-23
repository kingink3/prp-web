const sources = new WeakMap();
const linesOf = text => text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? [];
const endingOf = line => line.match(/(?:\r\n|\n|\r)$/)?.[0] ?? '';
const lineText = line => line.replace(/(?:\r\n|\n|\r)$/, '');
const defaultEnding = lines => lines.map(endingOf).find(Boolean) ?? '\n';
const listItem = /^[ \t]*-[ \t]+(.*)$/;
const taskItem = /^([ \t]*-[ \t]+\[)([ xX])(\][ \t]+)(.*?)([ \t]*)$/;
const tasksTitle = 'Задачи';

function frontMatterEnd(lines) {
  if (lineText(lines[0] ?? '').replace(/^\uFEFF/, '').trimEnd() !== '---') return -1;
  return lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(lineText(line)));
}

// Only punctuation outside quoted scalars can start a comment or delimit a flow item.
function outsideQuotes(text, delimiter, flow) {
  const positions = [];
  let quote = '';
  let atStart = true;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (quote) {
      if ((quote === '"' && char === '\\') || (quote === "'" && char === "'" && next === "'")) index++;
      else if (char === quote) quote = '';
    } else {
      if (delimiter(char, index)) {
        positions.push(index);
        if (char === '#') break;
      }
      if (atStart && (char === '"' || char === "'")) quote = char;
      if (flow && (char === '[' || char === ',')) atStart = true;
      else if (char !== ' ' && char !== '\t') atStart = false;
    }
  }
  return positions;
}

function splitValue(text) {
  const [comment = text.length] = outsideQuotes(text, (char, index) =>
    char === '#' && (index === 0 || /\s/.test(text[index - 1])), text.startsWith('['));
  const value = text.slice(0, comment).trimEnd();
  return { value, suffix: text.slice(value.length) };
}

function scalar(value) {
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  if (/^(?:null|~)?$/i.test(value)) return null;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function parseValue(value) {
  if (!(value.startsWith('[') && value.endsWith(']'))) return scalar(value);
  const items = value.slice(1, -1);
  const commas = outsideQuotes(items, char => char === ',', true);
  let start = 0;
  const result = [];
  for (const end of [...commas, items.length]) {
    const item = items.slice(start, end).trim();
    if (item || end !== items.length) result.push(scalar(item));
    start = end + 1;
  }
  return result;
}

// A parsed document can be edited through its attributes and body, then serialized.
export function parseFrontMatter(markdown) {
  const lines = linesOf(markdown);
  const end = frontMatterEnd(lines);
  const fields = new Map();
  for (let index = 1; index < end; index++) {
    const match = /^([ \t]*([a-z_][a-z0-9_-]*):[ \t]*)(.*)$/i.exec(lineText(lines[index]));
    if (!match) continue;
    const [, prefix, key, raw] = match;
    const { value, suffix } = splitValue(raw);
    const items = [];
    if (!value) {
      let next = index + 1;
      for (; next < end; next++) {
        const item = listItem.exec(lineText(lines[next]));
        if (item) items.push({ index: next, value: scalar(splitValue(item[1]).value) });
        else if (!/^[ \t]*(?:#.*)?$/.test(lineText(lines[next]))) break;
      }
    }
    const parsed = items.length ? items.map(item => item.value) : parseValue(value);
    fields.set(key, { index, prefix, suffix, items, value: parsed });
    if (items.length) index = items.at(-1).index;
  }
  const attributes = Object.fromEntries([...fields].map(([key, { value }]) =>
    [key, Array.isArray(value) ? [...value] : value]));
  const document = { attributes, body: lines.slice(end + 1).join('') };
  sources.set(document, { header: lines.slice(0, end + 1), fields, eol: defaultEnding(lines) });
  return document;
}

function sameValue(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return Object.is(left, right);
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function formatScalar(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  throw new TypeError('Expected a YAML scalar');
}

function formatValue(value) {
  return Array.isArray(value) ? '[' + value.map(formatScalar).join(', ') + ']' : formatScalar(value);
}

export function serializeFrontMatter(document) {
  const { attributes, body } = document;
  const { header, fields, eol } = sources.get(document) ?? { header: [], fields: new Map(), eol: '\n' };
  const lines = [...header];
  for (const [key, field] of fields) {
    const exists = Object.hasOwn(attributes, key);
    if (exists && sameValue(field.value, attributes[key])) continue;
    const { index, prefix, suffix, items } = field;
    for (const item of items) lines[item.index] = '';
    const gap = prefix.endsWith(':') ? ' ' : '';
    const commentGap = suffix.startsWith('#') ? ' ' : '';
    lines[index] = exists ? prefix + gap + formatValue(attributes[key]) + commentGap + suffix + endingOf(lines[index]) : '';
  }
  const added = Object.entries(attributes).filter(([key]) => !fields.has(key)).map(([key, value]) => {
    if (!/^[a-z_][a-z0-9_-]*$/i.test(key)) throw new TypeError('Invalid YAML key');
    return key + ': ' + formatValue(value) + eol;
  });
  if (!lines.length) return added.length ? ['---' + eol, ...added, '---' + eol, body].join('') : body;
  const closing = lines.pop();
  return [...lines, ...added, closing, body && !endingOf(closing) ? eol : '', body].join('');
}

function* visibleMarkdownLines(lines, start, end) {
  let fence;
  for (let index = start; index < end; index++) {
    const text = lineText(lines[index]);
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (marker) {
      fence = marker[1];
    } else {
      yield { index, text };
    }
  }
}

function findSection(lines, title) {
  let heading = -1;
  let end = lines.length;
  for (const { index, text } of visibleMarkdownLines(lines, frontMatterEnd(lines) + 1, lines.length)) {
    const match = /^ {0,3}(#{1,2})(?:[ \t]+(.*?)|$)[ \t]*$/.exec(text);
    if (!match) continue;
    if (heading >= 0) {
      end = index;
      break;
    }
    if (match[1] === '##' && (match[2] ?? '').replace(/[ \t]+#+$/, '').trimEnd() === title) heading = index;
  }
  return { heading, end };
}

function sectionContent(lines, section) {
  let start = section.heading + 1;
  let end = section.end;
  while (start < end && !lineText(lines[start]).trim()) start++;
  while (end > start && !lineText(lines[end - 1]).trim()) end--;
  return { start, end };
}

export function getSection(markdown, title) {
  const lines = linesOf(markdown);
  const section = findSection(lines, title);
  if (section.heading < 0) return undefined;
  const { start, end } = sectionContent(lines, section);
  return lineText(lines.slice(start, end).join(''));
}

function insertLines(lines, start, end, content, eol, finalEnding = eol) {
  const prefix = lines.slice(0, start).join('');
  const suffix = lines.slice(end).join('');
  if (!content) return prefix + suffix;
  const separator = prefix && !endingOf(prefix) ? eol : '';
  const tail = suffix ? finalEnding || eol : finalEnding;
  return prefix + separator + content + tail + suffix;
}

export function setSection(markdown, title, content) {
  const lines = linesOf(markdown);
  const section = findSection(lines, title);
  const eol = endingOf(lines[section.heading] ?? '') || defaultEnding(lines);
  const text = lineText(content);
  if (section.heading < 0) {
    if (!text) return markdown;
    const blank = lines.length && lineText(lines.at(-1)).trim() ? eol : '';
    return insertLines(lines, lines.length, lines.length, blank + '## ' + title + eol + text, eol);
  }
  const { start, end } = sectionContent(lines, section);
  if (lineText(lines.slice(start, end).join('')) === text) return markdown;
  if (start === end) {
    const insertAt = section.heading + 1;
    return insertLines(lines, insertAt, insertAt, text, eol);
  }
  return insertLines(lines, start, end, text, eol, endingOf(lines[end - 1]));
}

function readTasks(lines) {
  const section = findSection(lines, tasksTitle);
  const tasks = [];
  if (section.heading >= 0) {
    for (const { index, text } of visibleMarkdownLines(lines, section.heading + 1, section.end)) {
      const parts = taskItem.exec(text);
      if (parts) tasks.push({ index, parts, text: parts[4], done: parts[2] !== ' ' });
    }
  }
  return { section, tasks };
}

export function parseChecklist(markdown) {
  return readTasks(linesOf(markdown)).tasks.map(({ text, done }) => ({ text, done }));
}

export function setChecklist(markdown, checklist) {
  const lines = linesOf(markdown);
  const { section, tasks } = readTasks(lines);
  for (const { text } of checklist) {
    if (typeof text !== 'string' || !text.trim() || /[\r\n]/.test(text)) throw new TypeError('Expected single-line task text');
  }
  const eol = endingOf(lines[section.heading] ?? '') || defaultEnding(lines);
  const render = item => '- [' + (item.done ? 'x' : ' ') + '] ' + item.text;
  const inserted = checklist.slice(tasks.length).map(render).join(eol);
  if (section.heading < 0) return setSection(markdown, tasksTitle, inserted);
  for (const [position, task] of tasks.entries()) {
    const item = checklist[position];
    const [, prefix, mark, bracket, , trailing] = task.parts;
    const selected = item?.done === task.done ? mark : item?.done ? 'x' : ' ';
    lines[task.index] = item ? prefix + selected + bracket + item.text + trailing + endingOf(lines[task.index]) : '';
  }
  if (!inserted) return lines.join('');
  const start = tasks.length ? tasks.at(-1).index + 1 : sectionContent(lines, section).end;
  return insertLines(lines, start, start, inserted, eol);
}

export function tickChecklist(markdown, index, done = true) {
  const checklist = parseChecklist(markdown);
  if (!Object.hasOwn(checklist, index)) throw new RangeError('Unknown task index');
  checklist[index].done = done;
  return setChecklist(markdown, checklist);
}
