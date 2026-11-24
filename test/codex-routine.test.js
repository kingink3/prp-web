import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CODEX_STATUSES, codexActionStatus, codexPrompt, codexPullRequest, parseCodexTasks, updateCodexTask } from '../js/codex.js';
import { fireRoutine, isRoutineUrl, routinePayload } from '../js/routine.js';

const fixture = await readFile(new URL('../fixtures/lab/codex.json', import.meta.url), 'utf8');
const [task] = parseCodexTasks(fixture).tasks;
const at = '2030-01-15T10:01';

test('routine accepts only supported commands and complete arguments', () => {
  for (const input of [
    'extra_lesson', 'ideas: складные столы', 'critic: idea-20300115-course-builder',
    'кодекс: Добавить проверку.\nГотово: тесты проходят.', 'codex-review: 42',
    'codex-review: owner/another.repo#42', 'ок: 42', 'ок: owner/another.repo#42',
  ]) assert.equal(routinePayload(' ' + input + '\n'), input, input);

  for (const input of [
    '', 'что угодно', 'extra_lesson now', 'ideas:', 'ideas: \n ',
    'critic: 42', 'critic: project-20300115-course-builder', 'critic: idea-abc',
    'critic: idea-20300115-course-builder more', 'кодекс:', 'codex-review: 01',
    'codex-review: 0', 'ок: -3', 'ок: 1.5', 'ок: 42\nextra_lesson',
    'ок: owner/repo#', 'ок: owner/repo#42#7', 'ок: https://github.com/owner/repo/pull/42',
    'ок: owner/..#1',
  ]) assert.equal(routinePayload(input), null, input);
  assert.equal(routinePayload('Ideas: topic'), 'ideas: topic'); // names are normalised
});

test('routine fire URL is restricted to the exact HTTPS API origin', () => {
  assert.equal(isRoutineUrl('https://api.anthropic.com/routines/fixture/fire'), true);
  for (const url of [
    'http://api.anthropic.com/fire', 'https://api.anthropic.com', 'https://api.anthropic.com.evil/fire',
    'https://api.anthropic.com@elsewhere/fire', 'https://api.anthropic.com:444/fire',
    'https://api.anthropic.com/fire#fragment', 'https://api.anthropic.com/fire\n',
  ]) assert.equal(isRoutineUrl(url), false, url);
});

test('routine POST uses its own bearer header, blocks redirects, and only returns a status', async () => {
  const config = { url: 'https://api.anthropic.com/routines/fixture/fire', token: 'fixture-only' };
  const requests = [];
  for (const status of [202, 401, 404, 429, 500]) {
    const result = await fireRoutine(config, 'ок: owner/repo#42', async (url, options) => {
      requests.push({ url, options });
      return new Response('ignored body', { status });
    });
    assert.equal(result, status === 202 ? null : status);
  }
  assert.deepEqual(requests[0], {
    url: config.url,
    options: {
      method: 'POST',
      headers: {
        Authorization: 'Bearer fixture-only',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'Content-Type': 'application/json',
      },
      body: '{"text":"ок: owner/repo#42"}',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    },
  });
  const unused = () => assert.fail('Invalid requests must never reach fetch');
  await assert.rejects(fireRoutine(config, 'unsupported', unused), TypeError);
  await assert.rejects(fireRoutine({ ...config, url: 'https://api.anthropic.com.evil/fire' }, 'extra_lesson', unused), TypeError);
});

test('Codex prompt uses the fixture fields and the documented header and rules', () => {
  assert.equal(codexPrompt(task, 'owner/repo'), [
    'PRP task cx-1900000003 — Add tests',
    'Repository: <owner>/<data-repo>',
    'Model: MODEL · reasoning effort: medium (the owner selects these in Codex before running).',
    '',
    'Read AGENTS.md (and README) of this repository first and follow them.',
    '',
    'Task:',
    'Write tests for X.',
    '',
    'Done when:',
    'tests pass',
    '',
    'Rules:',
    '- Work on branch `codex/tests-0003`; put `cx-1900000003` in the PR title.',
    "- Run this repository's own tests/linters if it has them; describe how you verified in the PR.",
    "- User-facing text in the repository's existing language. When done, open a PR (Create PR).",
  ].join('\n'));
  assert.equal(codexPrompt({ ...task, status: 'changes', fix: 'Please add a missing case.\n' }), 'Please add a missing case.\n');
  assert.match(codexPrompt({ ...task, repo: null, model: null, effort: null }, 'owner/repo'),
    /Repository: owner\/repo\nModel: GPT-6\.2 Sol · reasoning effort: medium/);
});

test('Codex status transitions update only the chosen task', () => {
  const expected = [
    ['sent', 'cancelled', undefined],
    [undefined, 'cancelled', undefined],
    [undefined, 'cancelled', undefined],
    ['sent', 'cancelled', undefined],
    [undefined, undefined, undefined],
    [undefined, undefined, 'ready'],
  ];
  for (const [index, status] of CODEX_STATUSES.entries()) {
    const current = { ...task, status, pr: 7, fix: 'Fix one case' };
    const other = { ...task, id: 'cx-1' };
    const text = JSON.stringify({ version: 2, tasks: [other, current] });
    for (const [actionIndex, action] of ['copy', 'cancel', 'reopen'].entries()) {
      const target = expected[index][actionIndex];
      assert.equal(codexActionStatus(status, action), target);
      const result = updateCodexTask(text, current, action, 'owner/repo', at);
      if (!target) assert.equal(result, text);
      else assert.deepEqual(parseCodexTasks(result), {
        version: 2, tasks: [other, { ...current, status: target, updated: at }],
      });
    }
  }
});

test('Codex updates preserve concurrent status and prompt changes', () => {
  const review = JSON.stringify({ tasks: [{ ...task, status: 'review', pr: 1 }] });
  assert.equal(updateCodexTask(review, task, 'copy', 'owner/repo', at), review);
  assert.equal(updateCodexTask(review, task, 'cancel', 'owner/repo', at), review);
  const edited = JSON.stringify({ tasks: [{ ...task, text: 'New task instructions' }] });
  assert.equal(updateCodexTask(edited, task, 'copy', 'owner/repo', at), edited);
  const sent = updateCodexTask(fixture, task, 'copy', 'owner/repo', at);
  assert.equal(updateCodexTask(sent, task, 'copy', 'owner/repo', at), sent);
});

test('Codex PRs link to the right repository and qualify external approvals', () => {
  assert.deepEqual(codexPullRequest({ ...task, repo: 'Owner/Repo', pr: 42 }, 'owner/repo'), {
    repo: 'Owner/Repo', href: 'https://github.com/Owner/Repo/pull/42', payload: 'ок: 42',
  });
  assert.deepEqual(codexPullRequest({ ...task, repo: 'owner/other', pr: '42' }, 'owner/repo'), {
    repo: 'owner/other', href: 'https://github.com/owner/other/pull/42', payload: 'ок: owner/other#42',
  });
  assert.equal(codexPullRequest({ ...task, repo: '', pr: 42 }, 'owner/repo').payload, 'ок: 42');
  assert.equal(codexPullRequest({ ...task, repo: 'owner/repo', pr: '1?bogus' }, 'owner/repo'), null);
  assert.equal(codexPullRequest({ ...task, repo: 'javascript:alert(1)', pr: 42 }), null);
  assert.equal(codexPullRequest(task, 'owner/repo'), null);
});

import { normalizeRequest, routinePayload as payload2 } from '../js/routine.js';
import assertStrict from 'node:assert/strict';
import testFn from 'node:test';

testFn('Russian names and dashes become the exact routine form', () => {
  assertStrict.equal(normalizeRequest('идеи - генератор лиц'), 'ideas: генератор лиц');
  assertStrict.equal(normalizeRequest('Критик idea-20300115-sample-tool'), 'critic: idea-20300115-sample-tool');
  assertStrict.equal(normalizeRequest('ещё урок'), 'extra_lesson');
  assertStrict.equal(normalizeRequest('codex-review: 3'), 'codex-review: 3');
  assertStrict.equal(normalizeRequest('кодекс — сделать X'), 'кодекс: сделать X');
  assertStrict.equal(payload2('тест idea-20300115-sample-tool'), 'test: idea-20300115-sample-tool');
  assertStrict.equal(payload2('тест чего-то'), null);
});
