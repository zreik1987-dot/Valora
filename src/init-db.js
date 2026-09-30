'use strict';

// One-time database initialization: `npm run init`.
// (The server also creates the schema automatically on boot.)

const { createDb } = require('./db');

async function main() {
  const db = createDb(process.env.DATABASE_URL);
  await db.init();
  await db.close();
  console.log('Valora database schema initialized.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
