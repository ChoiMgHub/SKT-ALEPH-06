const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const allowedPriority = new Set(['낮음', '보통', '높음']);
const allowedStatus = new Set(['todo', 'doing', 'done', 'blocked']);

function response(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...jsonHeaders, ...extra } });
}
function fail(message, status = 400) { return response({ error: message }, status); }
function isDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }
function isTime(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function str(value, max = 200) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function minutes(value) { return Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1000000 ? Number(value) : null; }
function stamp() { return new Date().toISOString(); }
function rowCount(result) { return result?.meta?.changes || 0; }

async function body(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new Error('JSON 요청이 필요합니다.');
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 20000) throw new Error('입력 크기가 너무 큽니다.');
  return request.json();
}

function planInput(value) {
  const data = {
    title: str(value.title, 120), start_date: value.start_date, end_date: value.end_date,
    priority: value.priority, success_criteria: str(value.success_criteria, 1000),
    expected_minutes: minutes(value.expected_minutes)
  };
  if (!data.title || !isDate(data.start_date) || !isDate(data.end_date) || data.end_date < data.start_date ||
      !allowedPriority.has(data.priority) || !data.success_criteria || data.expected_minutes === null) {
    throw new Error('계획의 이름·기간·우선순위·성공 기준·예상 시간을 확인해 주세요.');
  }
  return data;
}

function taskInput(value) {
  const data = {
    title: str(value.title, 160), due_at: value.due_at || null,
    priority: value.priority, category: str(value.category, 50),
    expected_minutes: minutes(value.expected_minutes), status: value.status || 'todo',
    blocked_reason: str(value.blocked_reason, 500)
  };
  if (!data.title || (data.due_at && !isTime(data.due_at)) || !allowedPriority.has(data.priority) ||
      !data.category || data.expected_minutes === null || !allowedStatus.has(data.status)) {
    throw new Error('할 일의 이름·마감·우선순위·분류·예상 시간·상태를 확인해 주세요.');
  }
  if (data.status === 'blocked' && !data.blocked_reason) throw new Error('막힘 상태에는 이유가 필요합니다.');
  if (data.status !== 'blocked') data.blocked_reason = '';
  return data;
}

async function readState(db) {
  const [plans, planRevisions, tasks, logs, reflections] = await Promise.all([
    db.prepare('SELECT * FROM plans ORDER BY created_at DESC').all(),
    db.prepare('SELECT * FROM plan_revisions ORDER BY recorded_at DESC').all(),
    db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all(),
    db.prepare('SELECT * FROM execution_logs ORDER BY started_at DESC').all(),
    db.prepare('SELECT * FROM reflections').all()
  ]);
  const active = tasks.results.filter(x => !x.deleted_at);
  const now = Date.now();
  const summary = {
    plans: plans.results.length,
    open_tasks: active.length,
    completed: active.filter(x => x.status === 'done').length,
    overdue: active.filter(x => x.status !== 'done' && x.due_at && Date.parse(x.due_at) < now).length,
    blocked: active.filter(x => x.status === 'blocked').length,
    expected_minutes: active.reduce((n, x) => n + x.expected_minutes, 0),
    actual_minutes: logs.results.filter(x => active.some(t => t.id === x.task_id)).reduce((n, x) => n + x.actual_minutes, 0)
  };
  return { plans: plans.results, plan_revisions: planRevisions.results, tasks: tasks.results,
    execution_logs: logs.results, reflections: reflections.results, summary };
}

async function handleApi(request, env, path) {
  const db = env.DB;
  if (!db) return fail('서버 데이터베이스가 연결되지 않았습니다.', 503);
  const method = request.method;

  if (path === '/api/health' && method === 'GET') {
    await db.prepare('SELECT 1').first();
    return response({ ok: true, database: 'connected' });
  }
  if (path === '/api/state' && method === 'GET') return response(await readState(db));
  if (path === '/api/export' && method === 'GET') {
    const data = { schema_version: 'aleph-diary-v1', exported_at: stamp(), ...await readState(db) };
    return response(data, 200, { 'content-disposition': 'attachment; filename="aleph-diary-export.json"' });
  }

  if (path === '/api/plans' && method === 'POST') {
    const data = planInput(await body(request));
    const id = crypto.randomUUID(), now = stamp();
    await db.prepare('INSERT INTO plans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, data.title, data.start_date, data.end_date, data.priority, data.success_criteria,
        data.expected_minutes, now, now).run();
    return response({ id }, 201);
  }
  const planMatch = path.match(/^\/api\/plans\/([0-9a-f-]+)$/);
  if (planMatch && method === 'PATCH') {
    const old = await db.prepare('SELECT * FROM plans WHERE id = ?').bind(planMatch[1]).first();
    if (!old) return fail('계획을 찾을 수 없습니다.', 404);
    const data = planInput({ ...old, ...await body(request) });
    const changed = ['title','start_date','end_date','priority','success_criteria','expected_minutes'].some(k => old[k] !== data[k]);
    if (changed) {
      const now = stamp();
      await db.batch([
        db.prepare('INSERT INTO plan_revisions VALUES (?, ?, ?, ?)')
          .bind(crypto.randomUUID(), old.id, JSON.stringify(old), now),
        db.prepare('UPDATE plans SET title=?, start_date=?, end_date=?, priority=?, success_criteria=?, expected_minutes=?, updated_at=? WHERE id=?')
          .bind(data.title, data.start_date, data.end_date, data.priority, data.success_criteria,
            data.expected_minutes, now, old.id)
      ]);
    }
    return response({ id: old.id, changed });
  }

  if (path === '/api/tasks' && method === 'POST') {
    const input = await body(request);
    const plan = await db.prepare('SELECT id FROM plans WHERE id = ?').bind(input.plan_id).first();
    if (!plan) return fail('먼저 계획을 저장해 주세요.');
    const data = taskInput(input), id = crypto.randomUUID(), now = stamp();
    await db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)')
      .bind(id, plan.id, data.title, data.due_at, data.priority, data.category, data.expected_minutes,
        data.status, data.blocked_reason, now, now).run();
    return response({ id }, 201);
  }
  const taskMatch = path.match(/^\/api\/tasks\/([0-9a-f-]+)$/);
  if (taskMatch && (method === 'PATCH' || method === 'DELETE')) {
    const old = await db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').bind(taskMatch[1]).first();
    if (!old) return fail('할 일을 찾을 수 없습니다.', 404);
    if (method === 'DELETE') {
      await db.prepare('UPDATE tasks SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL')
        .bind(stamp(), stamp(), old.id).run();
      return response({ id: old.id, deleted: true });
    }
    const data = taskInput({ ...old, ...await body(request) });
    const result = await db.prepare('UPDATE tasks SET title=?, due_at=?, priority=?, category=?, expected_minutes=?, status=?, blocked_reason=?, updated_at=? WHERE id=? AND deleted_at IS NULL')
      .bind(data.title, data.due_at, data.priority, data.category, data.expected_minutes, data.status,
        data.blocked_reason, stamp(), old.id).run();
    return response({ id: old.id, updated: rowCount(result) > 0 });
  }

  if (path === '/api/logs' && method === 'POST') {
    const input = await body(request);
    const task = await db.prepare('SELECT id FROM tasks WHERE id=? AND deleted_at IS NULL').bind(input.task_id).first();
    if (!task) return fail('기록을 연결할 할 일을 찾을 수 없습니다.');
    const start = input.started_at, end = input.ended_at;
    if (!isTime(start) || !isTime(end) || Date.parse(end) < Date.parse(start)) return fail('실행 시작과 종료 시간을 확인해 주세요.');
    const requestId = str(input.request_id, 80);
    if (!requestId) return fail('기록 요청 번호가 필요합니다.');
    const existing = await db.prepare('SELECT id FROM execution_logs WHERE request_id=?').bind(requestId).first();
    if (existing) return response({ id: existing.id, duplicate: true });
    const actual = Math.round((Date.parse(end) - Date.parse(start)) / 60000);
    const id = crypto.randomUUID();
    try {
      await db.prepare('INSERT INTO execution_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, requestId, task.id, start, end, actual, str(input.difference_reason, 500), stamp()).run();
    } catch (error) {
      const duplicate = await db.prepare('SELECT id FROM execution_logs WHERE request_id=?').bind(requestId).first();
      if (duplicate) return response({ id: duplicate.id, duplicate: true });
      throw error;
    }
    return response({ id, actual_minutes: actual }, 201);
  }
  const reflectionMatch = path.match(/^\/api\/reflections\/([0-9a-f-]+)$/);
  if (reflectionMatch && method === 'PUT') {
    const plan = await db.prepare('SELECT id FROM plans WHERE id=?').bind(reflectionMatch[1]).first();
    if (!plan) return fail('계획을 찾을 수 없습니다.', 404);
    const input = await body(request), next = str(input.next_step, 500);
    await db.prepare('INSERT INTO reflections VALUES (?, ?, ?) ON CONFLICT(plan_id) DO UPDATE SET next_step=excluded.next_step, updated_at=excluded.updated_at')
      .bind(plan.id, next, stamp()).run();
    return response({ plan_id: plan.id });
  }
  return fail('요청한 기능을 찾을 수 없습니다.', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try { return await handleApi(request, env, url.pathname); }
    catch (error) {
      if (error instanceof SyntaxError) return fail('JSON 내용을 읽을 수 없습니다.');
      if (error.message && !/D1|SQL|database|constraint/i.test(error.message)) return fail(error.message);
      console.error('API error', error);
      return fail('저장 중 문제가 생겼습니다. 다시 시도해 주세요.', 500);
    }
  }
};
