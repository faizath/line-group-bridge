import { openDb } from './db.js';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const db = await openDb(url);
try {
  const applied = await migrate(db);
  console.log(applied.length ? `applied migrations: ${applied.join(', ')}` : 'schema up to date');
} finally {
  await db.close();
}
