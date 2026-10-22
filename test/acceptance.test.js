import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { summarize } from '../src/worker.js';
import { makeEnv, call } from '../test-support/helpers.mjs';

const planData = (title = '검증용 계획') => ({ title, start_date:'2026-10-21', end_date:'2026-10-28',
  priority:'보통', success_criteria:'검증용이며 개인의 실제 작업 기록이 아님', expected_minutes:120 });
const taskData = plan_id => ({plan_id, title:'검증용 할 일', due_at:'2026-10-21T09:00:00+09:00',
  priority:'높음', category:'검증', expected_minutes:30, status:'todo'});
async function fixture() {
  const env = makeEnv();
  const planId = (await call(env,'/api/plans','POST',planData())).data.id;
  const taskId = (await call(env,'/api/tasks','POST',taskData(planId))).data.id;
  return {env,planId,taskId};
}
const logData = task_id => ({task_id, request_id:'검증-중복-요청',started_at:'2026-10-21T10:00:00+09:00',
  ended_at:'2026-10-21T10:25:00+09:00',difference_reason:'자동 테스트 자료'});

test('C21 C22: concurrent completion, undo and re-complete preserve exactly one completion row', async () => {
  const {env,taskId} = await fixture();
  await Promise.all([call(env,`/api/tasks/${taskId}`,'PATCH',{status:'done'}), call(env,`/api/tasks/${taskId}`,'PATCH',{status:'done'})]);
  let s = (await call(env,'/api/state')).data;
  assert.equal(s.summary.completed,1); assert.equal(s.task_completions.length,1);
  assert.equal(s.execution_logs.length,0); // 완료 처리가 입력하지 않은 작업 시간을 만들지 않는다.
  const first = s.task_completions[0];
  await call(env,`/api/tasks/${taskId}`,'PATCH',{status:'doing'});
  s = (await call(env,'/api/state')).data; assert.equal(s.summary.completed,0); assert.equal(s.task_completions.length,1);
  await call(env,`/api/tasks/${taskId}`,'PATCH',{status:'done'});
  s = (await call(env,'/api/state')).data; assert.equal(s.summary.completed,1); assert.deepEqual(s.task_completions,[first]);
});

test('C23-C27 C35: duplicate execution, UTC round-trip, prior estimates and revision remain intact', async () => {
  const {env,planId,taskId} = await fixture();
  const original = (await call(env,'/api/state')).data;
  await call(env,`/api/plans/${planId}`,'PATCH',{expected_minutes:150});
  await Promise.all([call(env,'/api/logs','POST',logData(taskId)),call(env,'/api/logs','POST',logData(taskId))]);
  const s = (await call(env,'/api/state')).data;
  assert.equal(s.execution_logs.length,1); assert.equal(s.execution_logs[0].actual_minutes,25);
  assert.equal(s.execution_logs[0].started_at,'2026-10-21T01:00:00.000Z');
  assert.equal(s.tasks[0].due_at,'2026-10-21T00:00:00.000Z');
  assert.equal(s.tasks[0].expected_minutes,30); assert.equal(s.plans[0].expected_minutes,150);
  assert.deepEqual(JSON.parse(s.plan_revisions[0].snapshot_json),original.plans[0]);
  assert.deepEqual((await call(env,'/api/state')).data.execution_logs,s.execution_logs);
});

test('C28-C32: exact expiry boundary, blocked reasons, empty sets and signed differences', () => {
  const now = Date.parse('2026-10-22T00:00:00Z');
  const task = (id, extra = {}) => ({id,status:'todo',deleted_at:null,due_at:null,blocked_reason:'',expected_minutes:10,...extra});
  const tasks = [task('a',{due_at:'2026-10-21T23:59:59Z'}),task('b',{due_at:'2026-10-22T00:00:00Z'}),
    task('c',{status:'done',due_at:'2020-01-01T00:00:00Z'}),task('d',{status:'blocked',blocked_reason:'막힌 이유'}),
    task('deleted',{deleted_at:'2026-10-20T00:00:00Z'})];
  const s = summarize([{id:'p'}],tasks,[{task_id:'a',actual_minutes:15},{task_id:'deleted',actual_minutes:999}],now);
  assert.deepEqual(s,{plans:1,open_tasks:4,completed:1,overdue:1,blocked:1,expected_minutes:40,actual_minutes:15,difference_minutes:-25});
  assert.equal(summarize([],[],[],now).difference_minutes,0);
  assert.equal(summarize([], [task('a')], [{task_id:'a',actual_minutes:20}],now).difference_minutes,10);
});

test('C33: reflection is carried into a new plan with immutable source evidence', async () => {
  const {env,planId} = await fixture();
  await call(env,`/api/reflections/${planId}`,'PUT',{next_step:'실제 시간을 보고 다음 예상을 정한다'});
  const next = await call(env,'/api/plans','POST',{...planData('다음 검증용 계획'),success_criteria:'실제 시간을 보고 다음 예상을 정한다',source_reflection_plan_id:planId});
  assert.equal(next.status,201);
  await call(env,`/api/reflections/${planId}`,'PUT',{next_step:'나중에 바꾼 회고'});
  const s = (await call(env,'/api/state')).data;
  assert.equal(s.reflection_links[0].target_plan_id,next.data.id);
  assert.equal(s.reflection_links[0].source_plan_id,planId);
  assert.equal(s.reflection_links[0].carried_text,'실제 시간을 보고 다음 예상을 정한다');
  assert.equal(s.summaries[next.data.id].open_tasks,0);
});

test('C13 C28 C32 C36: moving and deleting a task changes the correct scope; export retains all evidence', async () => {
  const {env,planId,taskId} = await fixture();
  await call(env,'/api/logs','POST',logData(taskId));
  const nextId = (await call(env,'/api/plans','POST',planData('다른 계획'))).data.id;
  await call(env,`/api/tasks/${taskId}`,'PATCH',{plan_id:nextId,status:'done'});
  let s = (await call(env,'/api/state')).data;
  assert.equal(s.summaries[planId].open_tasks,0); assert.equal(s.summaries[nextId].actual_minutes,25);
  await call(env,`/api/tasks/${taskId}`,'DELETE');
  s = (await call(env,'/api/export')).data;
  assert.equal(s.summary.open_tasks,0); assert.equal(s.summary.actual_minutes,0);
  assert.equal(s.tasks.length,1); assert.equal(s.execution_logs.length,1); assert.equal(s.task_completions.length,1);
  const ajv = new Ajv2020({strict:false}); addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(new URL('../contracts/pds-schema-v2.json',import.meta.url),'utf8')));
  assert.equal(validate(s),true,JSON.stringify(validate.errors));
});

test('schema upgrade is repeatable and preserves old completed tasks without fabricated execution time', async () => {
  const {env,taskId} = await fixture();
  await call(env,`/api/tasks/${taskId}`,'PATCH',{status:'done'});
  env.DB.raw.exec('DROP TABLE task_completions; DROP TABLE reflection_links;');
  const schema = readFileSync(new URL('../schema.sql',import.meta.url),'utf8');
  env.DB.raw.exec(schema); env.DB.raw.exec(schema);
  const s = (await call(env,'/api/state')).data;
  assert.equal(s.task_completions.length,1); assert.equal(s.task_completions[0].source,'existing_status');
  assert.equal(s.task_completions[0].completed_at,s.tasks[0].updated_at);
  assert.equal(s.execution_logs.length,0);
});

test('invalid calendar dates, times, empty durations and malformed JSON are rejected', async () => {
  const {env,taskId} = await fixture();
  assert.equal((await call(env,'/api/plans','POST',{...planData(),start_date:'2026-02-30'})).status,400);
  assert.equal((await call(env,'/api/plans','POST',{...planData(),expected_minutes:null})).status,400);
  assert.equal((await call(env,'/api/logs','POST',{...logData(taskId),started_at:'2026-10-21T24:00:00Z'})).status,400);
  assert.equal((await call(env,'/api/logs','POST',{...logData(taskId),ended_at:'2026-10-20T01:00:00Z'})).status,400);
  assert.equal((await call(env,'/api/plans','POST',null)).status,400);
});
