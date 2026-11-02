// Adapter PostgreSQL (Neon) cho giao diện prepare/bind/first/all/run/batch dùng chung với D1 và SQLite (CLAUDE.md mục 3).
// Chuỗi kết nối chỉ đọc từ biến môi trường DATABASE_URL, không ghi vào mã hay nhật ký (CLAUDE.md mục 2).
import { Pool, types, type PoolClient, type QueryResult } from 'pg';

// COUNT trả int8. Chuyển sang number vì mọi giá trị đếm trong dự án đều nhỏ hơn 2^53.
types.setTypeParser(20, (value: string) => Number(value));

type Queryable = Pool | PoolClient;

// Đổi dấu ? của D1/SQLite thành $1, $2, ... Bỏ qua dấu ? nằm trong chuỗi nháy đơn.
export function toPositionalSql(sql: string): string {
  let index = 0;
  let inString = false;
  let out = '';
  for (const ch of sql) {
    if (ch === "'") inString = !inString;
    if (ch === '?' && !inString) {
      index += 1;
      out += `$${index}`;
    } else {
      out += ch;
    }
  }
  return out;
}

export class PgStatement {
  constructor(
    private readonly pool: Pool,
    private readonly sql: string,
    private readonly params: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): PgStatement {
    return new PgStatement(this.pool, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const result = await this.execute(this.pool);
    return (result.rows[0] as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const result = await this.execute(this.pool);
    return { results: result.rows as T[] };
  }

  async run(): Promise<{ results: unknown[]; meta: { changes: number } }> {
    const result = await this.execute(this.pool);
    return { results: [], meta: { changes: result.rowCount ?? 0 } };
  }

  // Chạy trên một kết nối cụ thể. Batch truyền kết nối của giao dịch vào đây.
  execute(target: Queryable): Promise<QueryResult> {
    // Không tham số thì gửi undefined: pg dùng giao thức đơn giản, cho phép nhiều câu lệnh trong một chuỗi (migration, seed).
    const values = this.params.length > 0 ? [...this.params] : undefined;
    return target.query(toPositionalSql(this.sql), values);
  }
}

export class PgDb {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
  }

  prepare(sql: string): PgStatement {
    return new PgStatement(this.pool, sql);
  }

  // Các câu lệnh trong batch chạy trong một giao dịch: lỗi một câu thì hủy cả batch (như D1).
  async batch(statements: PgStatement[]): Promise<unknown[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const results: unknown[] = [];
      for (const statement of statements) {
        results.push(await statement.execute(client));
      }
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
