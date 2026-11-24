import { isRepository } from './github.js';
import { isPullNumber } from './routine.js';
import { localIsoMinutes } from './util.js';

export const CODEX_PATH = 'codex.json';
export const CODEX_STATUSES = ['ready', 'sent', 'review', 'changes', 'merged', 'cancelled'];
const TRANSITIONS = {
  ready: { copy: 'sent', cancel: 'cancelled' },
  sent: { cancel: 'cancelled' },
  review: { cancel: 'cancelled' },
  changes: { copy: 'sent', cancel: 'cancelled' },
  merged: {},
  cancelled: { reopen: 'ready' },
};

export function parseCodexTasks(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data?.tasks)) throw new TypeError('Expected a Codex task list');
  return data;
}

export function codexPrompt(task, repository) {
  if (task.status === 'changes' && task.fix?.trim()) return task.fix;
  const { id, title, repo, model, effort, text, done_when, branch } = task;
  return [
    `PRP task ${id} — ${title}`,
    `Repository: ${repo || repository}`,
    `Model: ${model || 'GPT-6.2 Sol'} · reasoning effort: ${effort || 'medium'} (the owner selects these in Codex before running).`,
    '',
    'Read AGENTS.md (and README) of this repository first and follow them.',
    '',
    'Task:',
    text,
    '',
    'Done when:',
    done_when,
    '',
    'Rules:',
    branch ? `- Work on branch \`${branch}\`; put \`${id}\` in the PR title.` : `- Put \`${id}\` in the PR title.`,
    "- Run this repository's own tests/linters if it has them; describe how you verified in the PR.",
    "- User-facing text in the repository's existing language. When done, open a PR (Create PR).",
  ].join('\n');
}

export function codexActionStatus(status, action) {
  return Object.hasOwn(TRANSITIONS, status) && Object.hasOwn(TRANSITIONS[status], action)
    ? TRANSITIONS[status][action]
    : undefined;
}

export function updateCodexTask(text, task, action, repository, at = localIsoMinutes()) {
  const status = codexActionStatus(task.status, action);
  if (!status) return text;
  const data = parseCodexTasks(text);
  const current = data.tasks.find(item => item?.id === task.id);
  if (!current || current.status !== task.status ||
      (action === 'copy' && codexPrompt(current, repository) !== codexPrompt(task, repository))) return text;
  current.status = status;
  current.updated = at;
  return JSON.stringify(data, null, 2) + '\n';
}

export function codexPullRequest(task, defaultRepo) {
  const repo = task.repo || defaultRepo;
  if (typeof repo !== 'string' || !isRepository(repo) || !isPullNumber(task.pr)) return null;
  const sameRepo = repo.toLowerCase() === defaultRepo?.toLowerCase();
  return {
    repo,
    href: `https://github.com/${repo}/pull/${task.pr}`,
    payload: `ок: ${sameRepo ? '' : repo + '#'}${task.pr}`,
  };
}
