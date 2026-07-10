const exp = require('express');
const os = require('os');
const app = exp();

// ---------------------------------------------------------------------------
// APP IDENTITY  — set these per instance so two parallel apps are tellable apart
// Run app 1:  APP_NAME=APP-1 PORT=3076 LOOP_MS=3000 node index.js
// Run app 2:  APP_NAME=APP-2 PORT=3077 LOOP_MS=7000 node index.js
// ---------------------------------------------------------------------------
const APP_NAME = process.env.APP_NAME || 'APP-1';
const port = Number(process.env.PORT) || 3076;
const LOOP_MS = Number(process.env.LOOP_MS) || 5000;

// Prefix every log line with the app name + timestamp so parallel runs are clear
const stamp = () => `[${APP_NAME}] [${new Date().toLocaleTimeString()}]`;
const log = (...args) => console.log(stamp(), ...args);
const logError = (...args) => console.error(stamp(), ...args);

// ---------------------------------------------------------------------------
// ACTIVE REQUEST COUNTER
// Incremented when a request arrives, decremented when its response finishes.
// ---------------------------------------------------------------------------
let activeRequests = 0;

// How long the `/` route holds the connection open (ms)
const SLOW_MS = Number(process.env.SLOW_MS) || 20000;

// ---------------------------------------------------------------------------
// 1) REQUEST LOGGER  (middleware)
// Runs on EVERY request so you see logs in the terminal each time a page is hit
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
    activeRequests++;
    log(`--> ${req.method} ${req.url} | active: ${activeRequests}`);

    // 'finish' fires when the response is fully sent; 'close' if client aborts
    res.on('close', () => {
        activeRequests--;
        log(`<-- ${req.method} ${req.url} | active: ${activeRequests}`);
    });

    next(); // pass control to the next handler
});

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------
// Deliberately SLOW route: holds the request open for SLOW_MS so you can watch
// the active request count climb in the logs while several curls run at once.
app.get('/', (req, res) => {
    log(`[SLOW] holding request for ${SLOW_MS} ms | active: ${activeRequests}`);
    logError(`[SLOW-ERR] holding request for ${SLOW_MS} ms | active: ${activeRequests}`);

    setTimeout(() => {
        res.send(`Hello World from ${APP_NAME} after ${SLOW_MS} ms`);
    }, SLOW_MS);
});

// A route that ON PURPOSE throws an error so you can see error handling work.
app.get('/boom', (req, res) => {
    throw new Error('Something went wrong on purpose!');
});

// A route that shows the current stats as JSON in the browser
app.get('/stats', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        app: APP_NAME,
        activeRequests, // how many requests are in flight right now
        uptimeSeconds: Math.round(process.uptime()),
        memoryMB: {
            heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(2),
            rss: (mem.rss / 1024 / 1024).toFixed(2),
        },
        cpuLoad: os.loadavg(), // [1min, 5min, 15min] averages
    });
});

// ---------------------------------------------------------------------------
// 2) ERROR HANDLER  (must have 4 arguments: err, req, res, next)
// Express automatically sends errors from routes here.
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
    logError(`ERROR: ${err.message}`); // log the error in the terminal
    res.status(500).send(`Oops! Server error on ${APP_NAME}: ` + err.message);
});

// ---------------------------------------------------------------------------
// 3) THE LOOP  — logs memory + CPU usage on an interval you control via LOOP_MS
// setInterval keeps running while the server is alive
// ---------------------------------------------------------------------------
setInterval(() => {
    const mem = process.memoryUsage();
    const heapUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
    const rssMB = (mem.rss / 1024 / 1024).toFixed(2);
    const load = os.loadavg()[0].toFixed(2); // 1-minute CPU load average

    log(
        `[MONITOR11111] Active: ${activeRequests} | Memory heap: ${heapUsedMB} MB | RSS: ${rssMB} MB | CPU load(1m): ${load}`
    );

    // Also write to stderr so this shows up in PM2's ERROR log (~/.pm2/logs/*-error.log)
    logError(
        `[MONITOR-ERR] Active: ${activeRequests} | Memory heap: ${heapUsedMB} MB | RSS: ${rssMB} MB | CPU load(1m): ${load}`
    );
}, LOOP_MS);

// ---------------------------------------------------------------------------
// Catch crashes so the app logs the problem instead of dying silently
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
    logError('UNCAUGHT EXCEPTION:', err.message);
});
process.on('unhandledRejection', (err) => {
    logError('UNHANDLED PROMISE REJECTION:', err);
});

app.listen(port, () => {
    log(`Server is running on port ${port} (loop every ${LOOP_MS} ms)`);
});
