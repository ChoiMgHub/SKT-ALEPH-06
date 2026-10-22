import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call } from '../test-support/helpers.mjs';

test('plan revisions preserve prior values and execution logs do not overwrite estimates', async () => {
  const env = makeEnv();
  const plan = await call(env, '/api/plans', 'POST', {
    title: '6장 과제 완성하기', start_date: '2026-10-21', end_date: '2026-10-28',
    priority: '보통', success_criteria: '공개 링크와 근거 기록 확인', expected_minutes: 120
  });
  assert.equal(plan.status, 201);
  const planId = plan.data.id;
  const edit = await call(env, `/api/plans/${planId}`, 'PATCH', { expected_minutes: 150 });
  assert.equal(edit.data.changed, true);
  const task = await call(env, '/api/tasks', 'POST', {
    plan_id: planId, title: '요구사항 정리', due_at: '2026-10-22T12:00:00.000Z',
    priority: '보통', category: '과제', expected_minutes: 30, status: 'todo'
  });
  assert.equal(task.status, 201);
  const taskId = task.data.id;
  const logData = { request_id: 'same-request', task_id: taskId,
    started_at: '2026-10-21T01:00:00.000Z', ended_at: '2026-10-21T01:25:00.000Z',
    difference_reason: '예상보다 빠르게 정리함' };
  const firstLog = await call(env, '/api/logs', 'POST', logData);
  const secondLog = await call(env, '/api/logs', 'POST', logData);
  assert.equal(firstLog.status, 201);
  assert.equal(secondLog.data.duplicate, true);
  const state = (await call(env, '/api/state')).data;
  assert.equal(state.plans[0].expected_minutes, 150);
  assert.equal(JSON.parse(state.plan_revisions[0].snapshot_json).expected_minutes, 120);
  assert.equal(state.tasks[0].expected_minutes, 30);
  assert.equal(state.execution_logs.length, 1);
  assert.equal(state.summary.actual_minutes, 25);
});

test('status updates are repeatable and completed tasks are not counted as overdue', async () => {
  const env = makeEnv();
  const planId = (await call(env, '/api/plans', 'POST', {
    title: '실제 계획', start_date: '2026-10-21', end_date: '2026-10-22',
    priority: '보통', success_criteria: '완료', expected_minutes: 10
  })).data.id;
  const taskId = (await call(env, '/api/tasks', 'POST', {
    plan_id: planId, title: '<script>alert(1)</script>', due_at: '2020-01-01T00:00:00.000Z',
    priority: '높음', category: '과제', expected_minutes: 10, status: 'todo'
  })).data.id;
  assert.equal((await call(env, '/api/state')).data.summary.overdue, 1);
  await call(env, `/api/tasks/${taskId}`, 'PATCH', { status: 'done' });
  await call(env, `/api/tasks/${taskId}`, 'PATCH', { status: 'done' });
  const state = (await call(env, '/api/state')).data;
  assert.equal(state.summary.completed, 1);
  assert.equal(state.task_completions.length, 1);
  assert.equal(state.task_completions[0].task_id, taskId);
  assert.equal(state.summary.overdue, 0);
  assert.equal(state.execution_logs.length, 0);
  assert.equal(state.tasks[0].title, '<script>alert(1)</script>');
  const exportData = (await call(env, '/api/export')).data;
  assert.equal(exportData.schema_version, 'pds-schema-v2');
  assert.equal(exportData.tasks.length, 1);
});

