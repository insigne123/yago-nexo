import { createPool, migrate } from "./db.js";

const db = createPool();
try {
  const applied = await migrate(db);
  console.log(applied.length ? `${applied.length} migraciones aplicadas` : "esquema al día");
} finally {
  await db.end();
}
