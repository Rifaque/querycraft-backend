// controllers/dbController.js
const path = require('path');
const fs = require('fs');
const jsonfile = require('jsonfile');
const { randomUUID } = require('crypto');
const tmp = require('tmp');
const csv = require('csv-parser');
const Database = require('better-sqlite3');
const { Client: PgClient } = require('pg');
const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');

const FILES_DB = path.join(__dirname, '..', 'db_files.json');

function loadFilesIndex() {
  try {
    return jsonfile.readFileSync(FILES_DB);
  } catch {
    return {};
  }
}
function saveFilesIndex(obj) {
  jsonfile.writeFileSync(FILES_DB, obj, { spaces: 2 });
}

/**
 * Save metadata for uploaded file
 * multer file object expected
 */
async function handleUpload(file) {
  const filesIdx = loadFilesIndex();
  const id = randomUUID();
  const ext = path.extname(file.originalname).toLowerCase();
  const type =
    ext === '.csv' ? 'csv'
      : ext === '.json' ? 'json'
      : (ext === '.sqlite' || ext === '.db') ? 'sqlite'
      : ext === '.sql' ? 'sql'
      : 'unknown';

  const meta = {
    id,
    originalName: file.originalname,
    path: file.path,
    size: file.size,
    uploadedAt: new Date().toISOString(),
    ext,
    type
  };
  filesIdx[id] = meta;
  saveFilesIndex(filesIdx);
  return { success: true, file: meta };
}

/**
 * Main entry: execute a SQL query against a file or a connection string,
 * or a Mongo structured query when connectionString points to Mongo.
 *
 * payload: {
 *   sourceType: 'file'|'connection',
 *   fileId?,
 *   connectionString?,
 *   query?,       // SQL query string for SQL engines or imported files
 *   mongo?,       // { collection, filter?, projection?, limit? } for MongoDB
 *   maxRows?
 * }
 */
async function executeQuery(payload) {
  if (!payload) throw new Error('empty_payload');

  const hasSQLQuery = !!(payload.query && String(payload.query).trim());
  const hasMongoQuery = !!(payload.mongo && payload.mongo.collection);

  if (!hasSQLQuery && !hasMongoQuery) {
    throw new Error('empty_query_or_mongo');
  }

  const maxRows = Number(payload.maxRows || 1000);
  const sourceType = payload.sourceType || (payload.fileId ? 'file' : 'connection');

  if (sourceType === 'file') {
    const filesIdx = loadFilesIndex();
    const meta = filesIdx[payload.fileId];
    if (!meta) throw new Error('file_not_found');
    if (meta.type === 'sqlite') {
      if (!hasSQLQuery) throw new Error('empty_query_for_sqlite_file');
      return runQueryOnSqliteFile(meta.path, payload.query, maxRows);
    } else {
      if (!hasSQLQuery) throw new Error('empty_query_for_file_import');
      return runQueryOnImportedFile(meta, payload.query, maxRows);
    }
  } else if (sourceType === 'connection') {
    if (!payload.connectionString) throw new Error('connectionString_required');
    const cs = payload.connectionString.trim();

    // Detect Mongo URIs
    if (cs.startsWith('mongodb://') || cs.startsWith('mongodb+srv://')) {
      // require a structured mongo object
      if (!hasMongoQuery) throw new Error('mongo_query_required_for_mongodb');
      return runQueryOnMongo(cs, payload.mongo || {}, maxRows);
    }

    // Postgres
    if (cs.startsWith('postgres://') || cs.startsWith('postgresql://')) {
      if (!hasSQLQuery) throw new Error('sql_query_required_for_postgres');
      return runQueryOnPostgres(cs, payload.query, maxRows);
    }

    // MySQL / MariaDB
    if (cs.startsWith('mysql://') || cs.startsWith('mariadb://')) {
      if (!hasSQLQuery) throw new Error('sql_query_required_for_mysql');
      return runQueryOnMySQL(cs, payload.query, maxRows);
    }

    throw new Error('unsupported_connection_type');
  } else {
    throw new Error('invalid_sourceType');
  }
}

/* ---------- helpers for SQL / file imports ---------- */

function runQueryOnSqliteFile(filePath, query, maxRows) {
  const db = new Database(filePath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const stmt = db.prepare(query);
    const rows = stmt.all();
    const sliced = Array.isArray(rows) ? rows.slice(0, maxRows) : [];
    const columns = sliced[0] ? Object.keys(sliced[0]) : [];
    return { source: 'sqlite-file', rows: sliced, columns, rowCount: sliced.length };
  } finally {
    db.close();
  }
}

async function runQueryOnImportedFile(meta, query, maxRows) {
  const tmpobj = tmp.fileSync({ postfix: '.sqlite' });
  const tmpDbPath = tmpobj.name;
  const db = new Database(tmpDbPath);
  try {
    if (meta.type === 'csv') {
      await importCsvToSqlite(meta.path, db, 'imported_csv');
    } else if (meta.type === 'json') {
      await importJsonToSqlite(meta.path, db, 'imported_json');
    } else if (meta.type === 'sql') {
      const sqlText = fs.readFileSync(meta.path, 'utf8');
      db.exec(sqlText);
    } else {
      const txt = fs.readFileSync(meta.path, 'utf8').trim();
      if (txt.startsWith('[')) {
        await importJsonToSqlite(meta.path, db, 'imported_json');
      } else {
        await importCsvToSqlite(meta.path, db, 'imported_csv');
      }
    }
    const stmt = db.prepare(query);
    const rows = stmt.all();
    const sliced = Array.isArray(rows) ? rows.slice(0, maxRows) : [];
    const columns = sliced[0] ? Object.keys(sliced[0]) : [];
    return { source: 'temp-sqlite-import', rows: sliced, columns, rowCount: sliced.length };
  } finally {
    db.close();
    try { tmpobj.removeCallback(); } catch { /* ignore */ }
  }
}

function importCsvToSqlite(csvPath, db, tableName) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(csvPath);
    const parser = csv();
    let headersCreated = false;
    const rowsBatch = [];
    stream.pipe(parser)
      .on('headers', (headers) => {
        const cols = headers.map(h => `"${h.replace(/"/g, '""')}" TEXT`);
        const createSQL = `CREATE TABLE IF NOT EXISTS "${tableName}" (${cols.join(',')});`;
        db.exec(createSQL);
        headersCreated = true;
      })
      .on('data', (data) => {
        rowsBatch.push(data);
        if (rowsBatch.length >= 500) {
          insertRows(db, tableName, rowsBatch.splice(0, rowsBatch.length));
        }
      })
      .on('end', () => {
        if (rowsBatch.length) insertRows(db, tableName, rowsBatch);
        resolve();
      })
      .on('error', (err) => reject(err));
  });
}

function insertRows(db, tableName, rows) {
  if (!rows || rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const placeholders = cols.map(_ => '?').join(',');
  const insertSQL = `INSERT INTO "${tableName}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${placeholders})`;
  const insert = db.prepare(insertSQL);
  const insertMany = db.transaction((data) => {
    for (const r of data) {
      const vals = cols.map(c => r[c] == null ? null : String(r[c]));
      insert.run(vals);
    }
  });
  insertMany(rows);
}

function importJsonToSqlite(jsonPath, db, tableName) {
  return new Promise((resolve, reject) => {
    try {
      const txt = fs.readFileSync(jsonPath, 'utf8');
      let arr = JSON.parse(txt);
      if (!Array.isArray(arr)) arr = [arr];
      if (arr.length === 0) return resolve();
      const cols = Array.from(new Set(arr.flatMap(o => Object.keys(o))));
      const colsDef = cols.map(c => `"${c}" TEXT`);
      db.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colsDef.join(',')});`);
      const normRows = arr.map(o => {
        const row = {};
        for (const c of cols) row[c] = o[c] == null ? null : String(o[c]);
        return row;
      });
      insertRows(db, tableName, normRows);
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

/* ---------- Postgres / MySQL helpers ---------- */

async function runQueryOnPostgres(connectionString, query, maxRows) {
  const client = new PgClient({ connectionString, statement_timeout: 10000 });
  await client.connect();
  try {
    const res = await client.query({ text: query });
    const columns = res.fields ? res.fields.map(f => f.name) : [];
    const rows = res.rows.slice(0, maxRows);
    return { source: 'postgres', rows, columns, rowCount: rows.length };
  } finally {
    await client.end();
  }
}

async function runQueryOnMySQL(connectionString, query, maxRows) {
  const conn = await mysql.createConnection(connectionString);
  try {
    const [rows, fields] = await conn.execute({ sql: query });
    const resultRows = Array.isArray(rows) ? rows.slice(0, maxRows) : [];
    const columns = fields ? fields.map(f => f.name) : (resultRows[0] ? Object.keys(resultRows[0]) : []);
    return { source: 'mysql', rows: resultRows, columns, rowCount: resultRows.length };
  } finally {
    await conn.end();
  }
}

/* ---------- MongoDB support ---------- */

/**
 * Run a MongoDB find query and return normalized results.
 * connectionString: full mongodb uri (should include DB name path if possible)
 * mongoQuery: { collection: string, filter?: object, projection?: object, limit?: number }
 */
async function runQueryOnMongo(connectionString, mongoQuery = {}, maxRows = 1000) {
  if (!mongoQuery || !mongoQuery.collection) {
    throw new Error('mongo.query_missing_collection');
  }

  const limit = Math.min(Number(mongoQuery.limit || maxRows || 1000), maxRows);
  const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 10000 });

  await client.connect();
  try {
    // Use DB from URI path if present; else client.db() returns default DB.
    const db = client.db(); 
    const coll = db.collection(mongoQuery.collection);

    const filter = (mongoQuery.filter && typeof mongoQuery.filter === 'object') ? mongoQuery.filter : {};
    const projection = (mongoQuery.projection && typeof mongoQuery.projection === 'object') ? mongoQuery.projection : undefined;

    const cursor = coll.find(filter, projection ? { projection } : {}).limit(limit);
    const docs = await cursor.toArray();

    // Normalize common BSON types to JSON-friendly values
    const normalized = docs.map(doc => {
      const out = {};
      for (const k of Object.keys(doc)) {
        const v = doc[k];
        if (v && typeof v === 'object') {
          // ObjectId
          if (v._bsontype === 'ObjectID' && typeof v.toString === 'function') {
            out[k] = String(v);
            continue;
          }
          // Date
          if (v instanceof Date) {
            out[k] = v.toISOString();
            continue;
          }
          // Keep nested objects and arrays as-is (they are JSON-friendly)
        }
        out[k] = v;
      }
      return out;
    });

    const columns = normalized.length ? Object.keys(normalized[0]) : [];
    return { source: 'mongodb', rows: normalized, columns, rowCount: normalized.length };
  } finally {
    await client.close();
  }
}

module.exports = {
  handleUpload,
  executeQuery
};
