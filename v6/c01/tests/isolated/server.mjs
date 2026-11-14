/* Isolated PostgreSQL instance for `verify.mjs`.
 *
 * Real PostgreSQL 18.6 (WASM build) behind a real wire-protocol TCP endpoint, so
 * multiple client sessions can connect with distinct roles. It owns its own data
 * directory and its own port — nothing here shares state with CloudBase, and the
 * suite never writes to CloudBase.
 *
 *   npm i pg @electric-sql/pglite-socket     # beside this suite
 *   ISO_DATA=/tmp/r5-iso-data ISO_PORT=55433 node tests/isolated/server.mjs
 *   ISO_PORT=55433 node tests/isolated/verify.mjs
 *
 * This file is committed so the isolated environment can be rebuilt exactly;
 * it is not part of the deployed candidate.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = process.env.ISO_DATA || path.join(os.tmpdir(), 'r5-iso-pgdata');
const PORT = Number(process.env.ISO_PORT || 55433);

fs.mkdirSync(DATA, { recursive: true });

const db = await PGlite.create({ dataDir: DATA });
const server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1', maxConnections: 24 });
await server.start();

const v = await db.query('SELECT version() AS v');
console.log(`READY port=${PORT} engine=${v.rows[0].v}`);
console.log(`STORE ${DATA}`);

const bye = async () => { try { await server.stop(); await db.close(); } catch { /* ignore */ } process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
setInterval(() => {}, 1 << 30);
