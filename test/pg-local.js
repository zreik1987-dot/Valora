'use strict';

// Local Postgres for the test suite.
//
// Uses the Postgres binaries shipped by the `embedded-postgres` npm package,
// running as the `postgres` system user (Postgres refuses to run as root).
// The server lives only for the test run: started on demand, stopped after.

const { execFileSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const NATIVE = path.join(
  __dirname, '..', 'node_modules', '@embedded-postgres', 'linux-x64', 'native'
);
const BIN = path.join(NATIVE, 'bin');
const LIB = path.join(NATIVE, 'lib');
const DATA = '/tmp/valora-pg/data';
const LOG = '/tmp/valora-pg/logfile';
const PORT = 55433;

function asPostgres(cmd) {
  execFileSync('su', ['postgres', '-s', '/bin/sh', '-c', `LD_LIBRARY_PATH=${LIB} ${cmd}`], {
    stdio: 'pipe',
  });
}

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.once('connect', () => {
      s.end();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

async function start() {
  try {
    asPostgres(`${BIN}/pg_ctl -D ${DATA} -l ${LOG} -o '-p ${PORT} -c listen_addresses=127.0.0.1' -w start`);
    return;
  } catch {
    // Either no data dir yet or a stale postmaster — init and retry.
  }
  execFileSync('mkdir', ['-p', '/tmp/valora-pg'], { stdio: 'pipe' });
  execFileSync('chown', ['postgres:postgres', '/tmp/valora-pg'], { stdio: 'pipe' });
  try {
    asPostgres(`${BIN}/initdb -D ${DATA} -U postgres --auth=trust -E UTF8 --locale=C`);
  } catch (e) {
    // Data dir may already exist from a previous run; continue to start.
  }
  asPostgres(`${BIN}/pg_ctl -D ${DATA} -l ${LOG} -o '-p ${PORT} -c listen_addresses=127.0.0.1' -w start`);
}

async function ensureRunning() {
  if (await portOpen()) return;
  await start();
  if (!(await portOpen())) {
    throw new Error('local test Postgres did not start (see ' + LOG + ')');
  }
}

async function stop() {
  try {
    asPostgres(`${BIN}/pg_ctl -D ${DATA} -m fast stop`);
  } catch {
    // already stopped — fine
  }
}

function databaseUrl(dbName) {
  return `postgres://postgres@127.0.0.1:${PORT}/${dbName}`;
}

// Drop and recreate a database so each app context starts empty.
async function resetDatabase(dbName) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: databaseUrl('postgres') });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await c.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await c.end();
  }
}

module.exports = { ensureRunning, stop, databaseUrl, resetDatabase };
