import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSource } from '../src/source.mjs';
import { run, mergePlan } from '../src/workflow.mjs';

const cases = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)));
const [independent, conflict] = cases;

async function tempStateDir() {
  return mkdtemp(path.join(tmpdir(), 'workflow-test-'));
}

test('三方核对：字段级合并规则', async () => {
  // 只有我方改 → 可写
  let plan = mergePlan({ method: 'manual' }, { method: 'automatic' }, { method: 'manual' });
  assert.deepEqual(plan.pending, ['method']);
  assert.deepEqual(plan.conflicts, []);
  // 双方改成相同结果 → 无需再写
  plan = mergePlan({ note: '原备注' }, { note: '现场新备注' }, { note: '现场新备注' });
  assert.equal(plan.fields.note.status, 'unchanged');
  assert.deepEqual(plan.pending, []);
  // 同字段各改不同值 → 真正冲突
  plan = mergePlan({ note: '原备注' }, { note: '导入备注' }, { note: '现场新备注' });
  assert.equal(plan.fields.note.status, 'conflict');
  assert.deepEqual(plan.pending, []);
  // 想写值等于基值（我方未改）→ 保留现场，不算冲突也不写
  plan = mergePlan({ method: 'manual' }, { method: 'manual' }, { method: 'automatic' });
  assert.equal(plan.fields.method.status, 'kept');
  assert.deepEqual(plan.pending, []);
  assert.deepEqual(plan.conflicts, []);
  // 缺少基值且回读不同 → 无法核对，留人工
  plan = mergePlan({}, { note: '导入备注' }, { note: '现场新备注' });
  assert.equal(plan.fields.note.status, 'conflict');
  // 版本变化后重新核对：对方已把字段改成同样结果 → 退出待写，不重复追加
  const before = mergePlan({ method: 'manual' }, { method: 'automatic' }, { method: 'manual', note: '现场新备注' });
  assert.deepEqual(before.pending, ['method']);
  const after = mergePlan({ method: 'manual' }, { method: 'automatic' }, { method: 'automatic', note: '现场新备注' });
  assert.deepEqual(after.pending, []);
  assert.equal(after.fields.method.status, 'unchanged');
});

test('中断恢复：以实际台账为准，重跑不重复写入已成功字段', { timeout: 30000 }, async () => {
  const source = await startSource(independent);
  const stateDir = await tempStateDir();
  try {
    const input = structuredClone(independent.input);
    const first = await run({ source: source.url, stateDir, input });
    assert.equal(first.state, 'saved');
    assert.equal(first.record.method, 'automatic');
    // 模拟中断后本地记录丢失：删掉落盘结果，只保留门户台账。
    await rm(path.join(stateDir, 'result.json'));
    const second = await run({ source: source.url, stateDir, input });
    assert.equal(second.state, 'unchanged');
    assert.equal(second.record.method, 'automatic');
    assert.equal(second.record.note, '现场新备注');
    // 整个过程中门户只收到一次成功的保存，版本只前进一格。
    assert.equal(source.portal.actions.filter(entry => entry.action === 'save').length, 1);
    assert.equal(source.portal.state.version, 3);
    // 重跑的结果同样落盘，且与返回值一致。
    const saved = JSON.parse(await readFile(path.join(stateDir, 'result.json')));
    assert.deepEqual(saved, second);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('真正冲突：整行不写，双方修改都不被覆盖', { timeout: 20000 }, async () => {
  const source = await startSource(conflict);
  const stateDir = await tempStateDir();
  try {
    const result = await run({ source: source.url, stateDir, input: structuredClone(conflict.input) });
    assert.equal(result.state, 'conflict');
    assert.deepEqual(result.review['真正冲突'], ['note']);
    // 台账保持现场值，版本未动，没有任何保存动作。
    assert.equal(source.portal.state.record.note, '现场新备注');
    assert.equal(source.portal.state.version, 2);
    assert.equal(source.portal.actions.filter(entry => entry.action === 'save').length, 0);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('增量录入：保留对方字段、回读核对规范化差异', { timeout: 20000 }, async () => {
  const source = await startSource(independent);
  const stateDir = await tempStateDir();
  try {
    const result = await run({ source: source.url, stateDir, input: structuredClone(independent.input) });
    assert.equal(result.state, 'saved');
    // 对方补的备注保留，我方写的采样方式生效，容器被门户规范化清空。
    assert.deepEqual(result.record, { note: '现场新备注', method: 'automatic', container: '' });
    assert.deepEqual(result.review['已写入'], ['method']);
    assert.deepEqual(result.review['保留未动'], ['note']);
    assert.deepEqual(result.review['规范化差异'], ['container']);
    assert.equal(result.fields.container.after, '');
    assert.equal(result.version.before, 2);
    assert.equal(result.version.after, 3);
    const saved = JSON.parse(await readFile(path.join(stateDir, 'result.json')));
    assert.deepEqual(saved, result);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('版本在编辑中变化：有限重试且最终只成功保存一次', { timeout: 30000 }, async () => {
  const source = await startSource(independent);
  const dirs = [await tempStateDir(), await tempStateDir()];
  try {
    const input = structuredClone(independent.input);
    // 两个执行体基于同一版本同时编辑同一行：后保存的一方必然遇到版本变化。
    const [first, second] = await Promise.all([
      run({ source: source.url, stateDir: dirs[0], input }),
      run({ source: source.url, stateDir: dirs[1], input }),
    ]);
    const states = [first.state, second.state].sort();
    // 一方写入成功；另一方重读后发现字段已是想写值，按 unchanged 结束而不是再次追加。
    assert.deepEqual(states, ['saved', 'unchanged']);
    assert.equal(source.portal.state.version, 3);
    assert.deepEqual(source.portal.state.record, { note: '现场新备注', method: 'automatic', container: '' });
    const successful = source.history.filter(entry => entry.method === 'POST' && entry.path === '/portal/action');
    assert.ok(successful.length >= 1);
  } finally {
    await source.close();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }
});
