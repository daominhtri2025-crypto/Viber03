import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadShared } from './route-harness.mjs';

// Kiểm thử adapter PostgreSQL trên PostgreSQL thật (CLAUDE.md mục 7: không mock tầng dữ liệu).
// Chạy cần biến TEST_DATABASE_URL trỏ tới cơ sở dữ liệu có tên kết thúc bằng "_test".
// Chuỗi kết nối không được ghi vào mã; kiểm thử từ chối chạy nếu thiếu biến hoặc tên không có "_test".

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('Thiếu TEST_DATABASE_URL: cần PostgreSQL thử nghiệm để chạy kiểm thử này (không bỏ qua để qua kiểm thử).');
}
const dbName = new URL(url).pathname.replace(/^\//, '');
if (!dbName.endsWith('_test')) {
  throw new Error('Từ chối chạy: tên cơ sở dữ liệu phải kết thúc bằng "_test" để không xóa nhầm dữ liệu thật.');
}

const { PgDb } = await loadShared('db-pg');
const progress = await loadShared('progress-service');
const identity = await loadShared('identity-service');
const dashboard = await loadShared('dashboard-queries');
const rules = await loadShared('dashboard-rules');

const db = new PgDb(url);
const NOW = '2026-11-02T01:00:00.000Z';

// Đặt lại schema trước mỗi lần chạy, rồi áp dụng migration PostgreSQL theo đúng thứ tự.
await db.batch([]);
await db.prepare('DROP SCHEMA IF EXISTS public CASCADE').run();
await db.prepare('CREATE SCHEMA public').run();
for (const file of ['drizzle/pg/0001_schema_postgres.sql', 'drizzle/pg/0002_seed_bai_hoc.sql']) {
  const sqlText = readFileSync(file, 'utf8');
  // Mỗi file là một chuỗi nhiều câu lệnh; pg cho phép gửi nhiều câu trong một truy vấn khi không có tham số.
  await db.prepare(sqlText).run();
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('chuyển ? thành $n đúng thứ tự và bỏ qua ? trong chuỗi nháy đơn', async () => {
  // Tham số được so sánh với cột có kiểu (như trong truy vấn của dự án). Không đưa tham số trần vào danh sách chọn:
  // PostgreSQL coi tham số không có ngữ cảnh là text, còn SQLite giữ nguyên kiểu số.
  const row = await db.prepare("SELECT '?' AS q FROM lessons WHERE lesson = ? AND title <> ?").bind(0, 'không có').first();
  assert.deepEqual(row, { q: '?' });
  const none = await db.prepare("SELECT lesson FROM lessons WHERE lesson = ? AND title = ?").bind(1, 'sai').first();
  assert.equal(none, null, 'tham số phải gắn đúng vị trí, không bị hoán đổi');
});

test('first trả null khi không có dòng; all trả results; run trả meta.changes', async () => {
  assert.equal(await db.prepare('SELECT lesson FROM lessons WHERE lesson = ?').bind(9999).first(), null);
  const { results } = await db.prepare('SELECT lesson FROM lessons ORDER BY lesson').all();
  assert.equal(results.length, 10);
  const result = await db.prepare('UPDATE lessons SET updated = updated WHERE lesson = ?').bind(0).run();
  assert.equal(result.meta.changes, 1);
});

test('COUNT trả số nguyên JavaScript (không phải chuỗi int8)', async () => {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM lessons').first();
  assert.equal(typeof row.n, 'number');
  assert.equal(row.n, 10);
});

test('seed bài học chạy lại không tạo bản trùng và không ghi đè bài đã có', async () => {
  await db.prepare("UPDATE lessons SET title = 'Tiêu đề đã sửa' WHERE lesson = 0").run();
  const seed = readFileSync('drizzle/pg/0002_seed_bai_hoc.sql', 'utf8');
  await db.prepare(seed).run();
  const row = await db.prepare('SELECT COUNT(*) AS n FROM lessons').first();
  assert.equal(row.n, 10);
  const edited = await db.prepare('SELECT title FROM lessons WHERE lesson = 0').first();
  assert.equal(edited.title, 'Tiêu đề đã sửa', 'seed không được ghi đè bài đã sửa (CLAUDE.md mục 4.16)');
  await db.prepare("UPDATE lessons SET title = 'Chỉnh điện thoại cho dễ sử dụng' WHERE lesson = 0").run();
});

test('batch là một giao dịch: lỗi một câu thì hủy cả batch', async () => {
  const learnerA = { id: 'pg-batch-a', code: 'PGA1' };
  const statements = [
    db.prepare('INSERT INTO learners(id,code,created) VALUES(?,?,?)').bind(learnerA.id, learnerA.code, NOW),
    db.prepare('INSERT INTO learners(id,code,created) VALUES(?,?,?)').bind('pg-batch-b', learnerA.code, NOW),
  ];
  await assert.rejects(db.batch(statements));
  assert.equal(await db.prepare('SELECT id FROM learners WHERE id = ?').bind(learnerA.id).first(), null,
    'câu đầu tiên phải bị hoàn tác khi câu thứ hai lỗi');
});

test('ensureLearnerCode: gọi lại trả cùng mã, không sinh mã thừa', async () => {
  let generated = 0;
  const newCode = () => `CODE${++generated}`;
  const first = await identity.ensureLearnerCode(db, 'pg-id-1', newCode, NOW);
  const second = await identity.ensureLearnerCode(db, 'pg-id-1', newCode, NOW);
  assert.equal(first, second);
  assert.equal(generated, 1);
});

test('syncProgress: done không bị hạ khi đồng bộ sau chỉ có read (quy tắc 4.1)', async () => {
  await db.prepare('INSERT INTO learners(id,code,created) VALUES(?,?,?)').bind('pg-prog', 'PGP1', NOW).run();
  await progress.syncProgress(db, 'pg-prog', [1], [1], NOW);
  await progress.syncProgress(db, 'pg-prog', [1], [], NOW);
  const row = await db.prepare('SELECT read, done FROM progress WHERE learner = ? AND lesson = ?').bind('pg-prog', 1).first();
  assert.deepEqual(row, { read: 1, done: 1 });
});

test('recordQuizPass: điểm kiểm tra chỉ tăng, không giảm', async () => {
  await progress.recordQuizPass(db, 'pg-prog', 2, NOW);
  await progress.recordQuizPass(db, 'pg-prog', 2, NOW);
  const row = await db.prepare('SELECT score FROM progress WHERE learner = ? AND lesson = ?').bind('pg-prog', 2).first();
  assert.equal(row.score, 1);
});

test('báo cáo theo ngày: mốc UTC 18:00 ngày 31/10 là ngày 01/11 theo UTC+7', async () => {
  await db.prepare('INSERT INTO quiz_attempts(id,learner,lesson,choice,correct,client_id,created) VALUES(?,?,?,?,?,?,?)')
    .bind('pg-qa-1', 'pg-prog', 3, 0, 1, 'pg-cid-1', '2026-10-31T18:00:00.000Z').run();
  const filter = dashboard.normalizeFilter({});
  const days = await dashboard.queryDailyAttempts(db, filter);
  const point = days.find((day) => day.day === '2026-11-01');
  assert.ok(point, 'phải có điểm ngày 2026-11-01');
  assert.equal(point.attempts, 1);
  assert.equal(rules.REPORT_UTC_OFFSET_MINUTES, 420);
});

test('quiz: ON CONFLICT trên (learner, client_id) giữ lượt đầu tiên', async () => {
  const insert = (id, choice) =>
    db.prepare('INSERT INTO quiz_attempts(id,learner,lesson,choice,correct,client_id,created) VALUES(?,?,?,?,?,?,?) ON CONFLICT(learner,client_id) DO NOTHING')
      .bind(id, 'pg-prog', 4, choice, 0, 'pg-cid-dup', NOW).run();
  await insert('pg-qa-dup-1', 0);
  await insert('pg-qa-dup-2', 1);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM quiz_attempts WHERE client_id = 'pg-cid-dup'").first();
  assert.equal(count.n, 1);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}\n  ${error.message}`);
  }
}
await db.close();
if (failed > 0) {
  console.error(`${failed} kiểm thử PostgreSQL thất bại`);
  process.exit(1);
}
console.log(`PASS: adapter PostgreSQL và các quy tắc nghiệp vụ trên PostgreSQL thật (${tests.length} kiểm thử)`);
