const exp = require('express');
const { Pool, escapeIdentifier, Client } = require('pg');
const os = require('os');

const app = exp();
app.use(exp.json()); // so POST bodies (JSON) get parsed

// ---------------------------------------------------------------------------
// APP IDENTITY — this is a SEPARATE server from index.js.
// index.js runs on 3076; this DB server defaults to 3078 so both can run
// at the same time without clashing.
//   node db-index.js
//   DB_PORT=4000 DB_NAME=mydb node db-index.js
// ---------------------------------------------------------------------------
const APP_NAME = process.env.APP_NAME || 'DB-APP';
const port = Number(process.env.DB_PORT) || 3078;

// ---------------------------------------------------------------------------
// CONNECTION SETTINGS — all overridable via env vars
// ---------------------------------------------------------------------------
const PGHOST = process.env.PGHOST || 'localhost';
const PGPORT = Number(process.env.PGPORT) || 5432;
const PGUSER = process.env.PGUSER || os.userInfo().username;
const PGPASSWORD = process.env.PGPASSWORD || undefined;
const DB_NAME = process.env.DB_NAME || 'testdb';

// Same timestamped log style as index.js so output is easy to follow
const stamp = () => `[${APP_NAME}] [${new Date().toLocaleTimeString()}]`;
const log = (...args) => console.log(stamp(), ...args);
const logError = (...args) => console.error(stamp(), ...args);

// ---------------------------------------------------------------------------
// SEED DATA — inserted on first boot, skipped afterwards (email is UNIQUE)
// ---------------------------------------------------------------------------
const SEED_USERS = [
    ['Aarav Patel', 'aarav@example.com', 28],
    ['Bhavya Shah', 'bhavya@example.com', 32],
    ['Charlie Nolan', 'charlie@example.com', 41],
    ['Diya Mehta', 'diya@example.com', 24],
    ['Evan Fisher', 'evan@example.com', 37],
    ['Bhavya Patel', 'bhavyap@example.com', 22],
    ['Krish 3', 'krish3@example.com', 29],
];

// A pool (not a single client) because a server handles many concurrent
// requests — the pool hands each one its own connection and reuses them.
const pool = new Pool({
    host: PGHOST,
    port: PGPORT,
    user: PGUSER,
    password: PGPASSWORD,
    database: DB_NAME,
});

pool.on('error', (err) => logError('IDLE CLIENT ERROR:', err.message));

// ---------------------------------------------------------------------------
// STARTUP STEP 1 — create the database if it isn't there yet.
// CREATE DATABASE can't run inside a transaction and has no IF NOT EXISTS,
// so we connect to the `postgres` maintenance db, check, and only create
// when missing. The pool above can't do this — it needs DB_NAME to exist.
// ---------------------------------------------------------------------------
async function createDatabase() {
    const client = new Client({
        host: PGHOST,
        port: PGPORT,
        user: PGUSER,
        password: PGPASSWORD,
        database: 'postgres',
    });

    await client.connect();
    log(`Connected to ${PGHOST}:${PGPORT} as "${PGUSER}"`);

    try {
        const { rowCount } = await client.query(
            'SELECT 1 FROM pg_database WHERE datname = $1',
            [DB_NAME]
        );

        if (rowCount > 0) {
            log(`Database "${DB_NAME}" already exists — skipping create`);
        } else {
            // Identifiers can't be parameterized, so quote it safely instead
            await client.query(`CREATE DATABASE ${escapeIdentifier(DB_NAME)}`);
            log(`Database "${DB_NAME}" created`);
        }
    } finally {
        await client.end();
    }
}

// ---------------------------------------------------------------------------
// STARTUP STEP 2 — make sure the table exists and has the seed rows.
// ---------------------------------------------------------------------------
async function setupAndSeed() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id         SERIAL PRIMARY KEY,
            name       TEXT NOT NULL,
            email      TEXT NOT NULL UNIQUE,
            age        INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    log('Table "users" is ready');

    // Turn the seed rows into ($1,$2,$3), ($4,$5,$6), ... with flat params
    const placeholders = SEED_USERS.map(
        (_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`
    ).join(', ');

    const inserted = await pool.query(
        `INSERT INTO users (name, email, age)
         VALUES ${placeholders}
         ON CONFLICT (email) DO NOTHING`,
        SEED_USERS.flat()
    );
    log(`Seeded ${inserted.rowCount} new row(s) (duplicates skipped)`);

    const { rows } = await pool.query('SELECT count(*)::int AS total FROM users');
    log(`Table now holds ${rows[0].total} row(s)`);
}

// ---------------------------------------------------------------------------
// REQUEST LOGGER (middleware) — logs every hit, same as index.js does
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
    log(`--> ${req.method} ${req.url}`);
    res.on('close', () => log(`<-- ${req.method} ${req.url} | ${res.statusCode}`));
    next();
});

// ---------------------------------------------------------------------------
// ROUTES — every one of them talks to Postgres
// ---------------------------------------------------------------------------

// Is the server up AND can it actually reach the database?
app.get('/health', async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT now() AS db_time');
        res.json({
            app: APP_NAME,
            status: 'ok',
            database: DB_NAME,
            dbTime: rows[0].db_time,
            poolTotal: pool.totalCount,
            poolIdle: pool.idleCount,
        });
    } catch (err) {
        next(err);
    }
});

// List every user
app.get('/users', async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            'SELECT id, name, email, age, created_at FROM users ORDER BY id'
        );
        res.json({ count: rows.length, users: rows });
    } catch (err) {
        next(err);
    }
});

// Fetch one user by id
app.get('/users/:id', async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            'SELECT id, name, email, age, created_at FROM users WHERE id = $1',
            [req.params.id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: `No user with id ${req.params.id}` });
        }
        res.json(rows[0]);
    } catch (err) {
        next(err);
    }
});

// Add a new user:
// curl -X POST localhost:3078/users -H 'Content-Type: application/json' \
//      -d '{"name":"Test User","email":"test@example.com","age":30}'
app.post('/users', async (req, res, next) => {
    const { name, email, age } = req.body || {};

    if (!name || !email) {
        return res.status(400).json({ error: 'name and email are required' });
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO users (name, email, age)
             VALUES ($1, $2, $3)
             RETURNING id, name, email, age, created_at`,
            [name, email, age ?? null]
        );
        log(`Created user #${rows[0].id} (${email})`);
        res.status(201).json(rows[0]);
    } catch (err) {
        // 23505 = unique_violation, i.e. that email is already taken
        if (err.code === '23505') {
            return res.status(409).json({ error: `Email "${email}" already exists` });
        }
        next(err);
    }
});

// Delete a user by id
app.delete('/users/:id', async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            'DELETE FROM users WHERE id = $1 RETURNING id, name, email',
            [req.params.id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: `No user with id ${req.params.id}` });
        }
        log(`Deleted user #${rows[0].id} (${rows[0].email})`);
        res.json({ deleted: rows[0] });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// ERROR HANDLER (must have 4 arguments: err, req, res, next)
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
    logError(`ERROR: ${err.message}`);
    res.status(500).json({ error: err.message });
});

// ---------------------------------------------------------------------------
// BOOT — set the database up first, THEN start listening. If the DB can't be
// reached there's no point serving requests, so exit loudly instead.
// ---------------------------------------------------------------------------
async function start() {
    await createDatabase();
    await setupAndSeed();

    const server = app.listen(port, () => {
        log(`DB server running on port ${port} (database "${DB_NAME}")`);
        log(`Try: curl localhost:${port}/users`);
    });

    // Close the HTTP server and drain the pool on Ctrl-C
    const shutdown = async () => {
        log('Shutting down...');
        server.close();
        await pool.end();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

start().catch((err) => {
    logError('STARTUP FAILED:', err.message);
    process.exit(1);
});
