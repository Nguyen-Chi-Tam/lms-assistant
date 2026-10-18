import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Sử dụng Connection String từ Supabase (cấu hình trong .env)
const connectionString = process.env.DATABASE_URL || '';

let client: postgres.Sql | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

function initClient(): ReturnType<typeof drizzle<typeof schema>> | null {
  if (!connectionString || connectionString.includes('[YOUR-PASSWORD]') || connectionString.includes('your-password')) return null;
  if (!client || !dbInstance) {
    try {
      // Tắt prepare để tương thích tốt hơn với môi trường serverless/pgbouncer
      client = postgres(connectionString, {
        prepare: false,
        max: process.env.NODE_ENV === 'production' ? 10 : 1,
        idle_timeout: 20,
        connect_timeout: 10,
      });
      dbInstance = drizzle(client, { schema });
    } catch (err) {
      console.warn('Postgres connection initialization failed:', err);
      return null;
    }
  }
  return dbInstance;
}

if (connectionString) {
  initClient();
}

// Xuất db instance theo tài liệu hướng dẫn Drizzle ORM
export const db = (dbInstance ||
  new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
    get(_target, prop) {
      const instance = initClient();
      if (!instance) {
        throw new Error('DATABASE_URL is not configured or connection failed');
      }
      return (instance as unknown as Record<string | symbol, unknown>)[prop];
    },
  })) as ReturnType<typeof drizzle<typeof schema>>;

export function getDb() {
  return initClient();
}

export { schema };

