// app.js — Express server for a DOT-style trucker logbook (GAME TIME ONLY)

// ====== Standard Node/Express imports ======
import express from "express";               // Web framework for routing and views
import path from "path";                     // Path utilities
import { fileURLToPath } from "url";         // To convert import.meta.url to file path
import morgan from "morgan";                 // HTTP request logger (dev friendly)

// fs-extra is CommonJS → import default, then destructure
import fsExtra from "fs-extra";              // File IO helpers (CJS default import)
const { readJSON, writeJSON, ensureDir, pathExists } = fsExtra;

import { request } from "undici";            // Modern HTTP client to fetch telemetry

// ====== Resolve __dirname in ESM ======
const __filename = fileURLToPath(import.meta.url);    // Current file's absolute path
const __dirname = path.dirname(__filename);          // Current dir path

// ====== App + basic config ======
const app = express();                       // Create Express app
const PORT = process.env.PORT || 3000;       // App port (separate from telemetry port)

// Tell Express to use EJS as the view engine
app.set("view engine", "ejs");

// Set where our .ejs templates live (the ./views folder)
app.set("views", path.join(__dirname, "views"));

// Serve static files (JS/CSS) from ./public
app.use("/public", express.static(path.join(__dirname, "public")));

// Log requests in dev format
app.use(morgan("dev"));

// Allow Express to parse URL-encoded bodies (forms)
app.use(express.urlencoded({ extended: true }));

// Allow Express to parse JSON bodies (AJAX fetches)
app.use(express.json());

// ====== Data directory + file paths (local JSON storage) ======
const DATA_DIR = path.join(__dirname, "data");                   // ./data
const FILE_SETTINGS = path.join(DATA_DIR, "app_settings.json");       // telemetry URL, driver etc.
const FILE_DRIVERS = path.join(DATA_DIR, "drivers.json");            // driver list + active driver
const FILE_DUTY_EVENTS = path.join(DATA_DIR, "duty_events.json");        // duty events history

// ====== Boot-time ensure data directory + seed files if missing ======
await ensureDir(DATA_DIR);                                                 // Make sure ./data exists

// Initialize app_settings.json with a default telemetry URL if missing
if (!(await pathExists(FILE_SETTINGS))) {
    await writeJSON(FILE_SETTINGS, {
        // IMPORTANT: point this to your ETS2/ATS Telemetry Web Server endpoint
        // The common default is http://localhost:25555/api/ets2/telemetry
        telemetry_url: "http://localhost:25555/api/ets2/telemetry",
        driver_name: "Driver Name"
    }, { spaces: 2 });
}

// Initialize drivers.json with a default active driver if missing
if (!(await pathExists(FILE_DRIVERS))) {
    await writeJSON(FILE_DRIVERS, {
        activeDriverId: "default",
        drivers: [
            { id: "default", name: "Driver Name" }
        ]
    }, { spaces: 2 });
}

// Initialize duty_events.json as empty array if missing
if (!(await pathExists(FILE_DUTY_EVENTS))) {
    await writeJSON(FILE_DUTY_EVENTS, [], { spaces: 2 });
}

// ====== In-memory telemetry cache (latest pull), no IRL extrapolation ======
let LAST_TELEMETRY = null;   // Will hold the latest telemetry JSON from the server

// ====== Small helpers to load/save local JSON ======
async function loadSettings() {
    return readJSON(FILE_SETTINGS);
}

async function saveSettings(s) {
    return writeJSON(FILE_SETTINGS, s, { spaces: 2 });
}

async function loadDrivers() {
    return readJSON(FILE_DRIVERS);
}

async function saveDrivers(d) {
    return writeJSON(FILE_DRIVERS, d, { spaces: 2 });
}

async function loadEvents() {
    return readJSON(FILE_DUTY_EVENTS);
}

async function saveEvents(list) {
    return writeJSON(FILE_DUTY_EVENTS, list, { spaces: 2 });
}

// ====== Game Time helpers (no IRL computations) ======

/**
 * Extract ISO date (YYYY-MM-DD) and time (HH:mm) from an ISO string like "0001-01-08T21:09:00Z".
 * We do NOT convert to local time; we keep it as-is in UTC "game time".
 */
function splitGameIso(iso) {
    // Defensive check for malformed strings
    if (!iso || typeof iso !== "string" || iso.length < 16) {
        return { date: "0001-01-01", time: "00:00" };
    }
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/**
 * Compare two game-time ISO strings lexicographically.
 * For properly zero-padded ISO 8601 Z strings, lexicographic order equals chronological order.
 */
function cmpGameIso(a, b) {
    return String(a).localeCompare(String(b));
}

/**
 * Convert game-time ISO to a JS Date (UTC). Node can parse year 0001 ISO correctly.
 * We only use this for math (differences), not to display IRL time.
 */
function toJsDate(iso) {
    return new Date(iso);
}

/**
 * Return minutes between two game-time ISO strings (end - start), clamped to >= 0.
 */
function minutesBetween(startIso, endIso) {
    const a = toJsDate(startIso).getTime();
    const b = toJsDate(endIso).getTime();
    const diffMs = Math.max(0, b - a);
    return Math.floor(diffMs / 60000);
}

/**
 * Return an ISO string for the midnight (00:00) of a game date like "0001-01-08".
 */
function isoAtMidnight(gameYmd) {
    return `${gameYmd}T00:00:00Z`;
}

/**
 * Return an ISO string for the end-of-day (24:00 → next day 00:00) for a game date.
 */
function isoAtEndOfDay(gameYmd) {
    // Quick-and-safe: construct JS date at midnight, add 24h, reformat ISO
    const d0 = new Date(`${gameYmd}T00:00:00Z`);
    const d1 = new Date(d0.getTime() + 24 * 60 * 60 * 1000);
    return d1.toISOString().replace(/\.\d{3}Z$/, "Z"); // Strip milliseconds for neatness
}

// ====== Compute day segments for an HOS-like grid from duty events ======
/**
 * Build the duty segments for a given game date (YYYY-MM-DD).
 * Rules:
 *  - Start from the last known event before that midnight (carry-over status),
 *  - Then apply all events on that date,
 *  - The last segment ends at end-of-day (or next event).
 * Returns an array of segments: { status, startIso, endIso } limited to the day.
 */
function buildDaySegments(allEvents, activeDriverId, gameYmd) {
    // Only use events for this driver
    const events = allEvents
        .filter(e => e.driverId === activeDriverId)
        .sort((a, b) => cmpGameIso(a.gameTimeIso, b.gameTimeIso));

    const dayStart = isoAtMidnight(gameYmd);
    const dayEnd = isoAtEndOfDay(gameYmd);

    // Find last event strictly before dayStart to know the carry-over status
    let lastBefore = null;
    for (const e of events) {
        if (cmpGameIso(e.gameTimeIso, dayStart) < 0) lastBefore = e; else break;
    }

    // Gather events that occur in [dayStart, dayEnd)
    const todays = events.filter(e =>
        cmpGameIso(e.gameTimeIso, dayStart) >= 0 && cmpGameIso(e.gameTimeIso, dayEnd) < 0
    );

    // Start with carry-over status or default OFF if none
    const segments = [];
    let currentStatus = lastBefore ? lastBefore.status : "OFF";
    let currentStart = dayStart;

    // For each event on this day, close the prior segment and start a new one
    for (const ev of todays) {
        const cutStart = cmpGameIso(ev.gameTimeIso, currentStart) > 0 ? ev.gameTimeIso : currentStart;
        if (cmpGameIso(cutStart, currentStart) > 0) {
            segments.push({ status: currentStatus, startIso: currentStart, endIso: cutStart });
        }
        currentStatus = ev.status;
        currentStart = ev.gameTimeIso;
    }

    // Close out to end-of-day
    if (cmpGameIso(currentStart, dayEnd) < 0) {
        segments.push({ status: currentStatus, startIso: currentStart, endIso: dayEnd });
    }

    return segments;
}

// ====== Telemetry fetching (NO IRL extrapolation; just poll the real HTTP endpoint) ======

/**
 * Retrieve telemetry JSON from configured telemetry_url.
 * We keep the latest blob in LAST_TELEMETRY and return it.
 */
async function fetchTelemetry() {
    const { telemetry_url } = await loadSettings(); // Load current telemetry endpoint
    try {
        const { body } = await request(telemetry_url, { method: "GET", headers: { "accept": "application/json" } });
        const json = await body.json();               // Parse telemetry JSON
        LAST_TELEMETRY = json;                        // Save in-memory copy
        return json;                                  // Return data to caller
    } catch (err) {
        // If the telemetry server is unreachable, keep LAST_TELEMETRY as-is and throw
        throw new Error(`Telemetry fetch failed: ${err.message}`);
    }
}

/**
 * Get current telemetry (try fresh fetch; if it fails, fall back to last cached).
 * Useful for UI that should keep rendering with last known data.
 */
async function getTelemetrySafe() {
    try {
        return await fetchTelemetry();  // Attempt fresh pull
    } catch {
        return LAST_TELEMETRY;          // Fallback to last known
    }
}

// ====== Routes ======

// Home → go to today's log (by GAME DATE from telemetry)
app.get("/", async (req, res) => {
    // Try to load telemetry to know the game date
    const telem = await getTelemetrySafe();
    if (telem && telem.game && telem.game.time) {
        const { date } = splitGameIso(telem.game.time);    // Extract YYYY-MM-DD from game.time
        return res.redirect(`/log/${date}`);               // Redirect to that day's log
    }
    // If telemetry is unknown, just render log without a date; the template will explain
    return res.redirect("/log");
});

// Log view for a particular GAME DATE (YYYY-MM-DD) — if no date, we try telemetry date
app.get("/log/:date?", async (req, res) => {
    const settings = await loadSettings();               // Driver name + telemetry URL
    const drivers = await loadDrivers();                // Active driver ID
    const events = await loadEvents();                 // All duty events

    // Try to get telemetry (fresh or cached)
    const telem = await getTelemetrySafe();

    // Determine the game date to show
    let gameDate = req.params.date;
    if (!gameDate && telem && telem.game && telem.game.time) {
        gameDate = splitGameIso(telem.game.time).date;     // Use current game date from telemetry
    }

    // If still no date (telemetry not available and no param), render with a notice
    if (!gameDate) {
        return res.render("log", {
            settings,
            drivers,
            activeDriverId: drivers.activeDriverId,
            telem,
            gameDate: null,
            segments: [],
            events: []
        });
    }

    // Build HOS-like segments for this game date
    const segments = buildDaySegments(events, drivers.activeDriverId, gameDate);

    // Render EJS with all data needed
    return res.render("log", {
        settings,
        drivers,
        activeDriverId: drivers.activeDriverId,
        telem,
        gameDate,
        segments,
        events: events
            .filter(e => e.driverId === drivers.activeDriverId && e.gameTimeIso.startsWith(gameDate))
            .sort((a, b) => cmpGameIso(a.gameTimeIso, b.gameTimeIso))
    });
});

// Lightweight telemetry proxy the front-end can poll to update cards
app.get("/api/telemetry", async (req, res) => {
    const data = await getTelemetrySafe();          // Try to fetch fresh, fallback to last known
    res.json({ ok: !!data, telemetry: data || null });
});

// Create a new duty event at the CURRENT GAME TIME from telemetry
app.post("/api/event", async (req, res) => {
    const { status, note } = req.body;             // Status string and optional note from UI
    const drivers = await loadDrivers();          // To know active driver
    const events = await loadEvents();           // Load existing events
    const telem = await fetchTelemetry();       // MUST fetch live to get current game time

    // Validate telemetry and game time presence
    if (!telem || !telem.game || !telem.game.time) {
        return res.status(503).json({ ok: false, error: "Telemetry not available (no game.time)." });
    }

    // Enforce the allowed set of statuses
    const ALLOWED = ["OFF", "SB", "D", "ON", "YM", "PC"];
    if (!ALLOWED.includes(String(status))) {
        return res.status(400).json({ ok: false, error: "Invalid status." });
    }

    // Compose the duty event
    const ev = {
        driverId: drivers.activeDriverId,             // Who made the event
        status: String(status),                       // Duty status (OFF/SB/D/ON/YM/PC)
        gameTimeIso: telem.game.time,                 // ABSOLUTE GAME TIME (string), never IRL
        odometerMi: telem.truck && typeof telem.truck.odometer === "number"
            ? telem.truck.odometer * 0.621371           // Convert km → miles
            : null,
        note: note ? String(note) : ""                // Optional text from UI
    };

    // Rule: do not allow "future" timestamps vs telemetry time — equal is allowed
    // Since we stamp with current telemetry time, this will always be "now" from the game's POV.

    // Append and persist
    events.push(ev);
    await saveEvents(events);

    // Return success with the new event
    return res.json({ ok: true, event: ev });
});

// Settings page (view)
app.get("/settings", async (req, res) => {
    const settings = await loadSettings();         // Read telemetry URL + driver name
    const drivers = await loadDrivers();          // Read drivers and active driver
    res.render("settings", { settings, drivers });
});

// Settings update (POST form)
app.post("/settings", async (req, res) => {
    const { telemetry_url, driver_name, activeDriverId } = req.body;

    // Load current
    const settings = await loadSettings();
    const drivers = await loadDrivers();

    // Update telemetry URL + driver name
    settings.telemetry_url = String(telemetry_url || settings.telemetry_url).trim();
    settings.driver_name = String(driver_name || settings.driver_name).trim();
    await saveSettings(settings);

    // If driver selection changed, update active
    if (activeDriverId && drivers.drivers.some(d => d.id === activeDriverId)) {
        drivers.activeDriverId = activeDriverId;
        await saveDrivers(drivers);
    }

    // Redirect back to settings
    res.redirect("/settings");
});

// Add a new driver (POST)
app.post("/settings/add-driver", async (req, res) => {
    const { newDriverName } = req.body;
    if (!newDriverName || !newDriverName.trim()) {
        return res.redirect("/settings");
    }
    const drivers = await loadDrivers();
    const id = newDriverName.trim().toLowerCase().replace(/\s+/g, "-");
    if (!drivers.drivers.find(d => d.id === id)) {
        drivers.drivers.push({ id, name: newDriverName.trim() });
        drivers.activeDriverId = id; // switch to the new one
        await saveDrivers(drivers);
    }
    res.redirect("/settings");
});

// ====== Start server ======
app.listen(PORT, () => {
    console.log(`Logbook running on http://localhost:${PORT}`);
});
