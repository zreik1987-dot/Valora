'use strict';

// Production entry point. The database schema is created automatically on boot.

const { createApp } = require('./app');

async function main() {
  const { app } = await createApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Valora marketplace listening on port ${port}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
