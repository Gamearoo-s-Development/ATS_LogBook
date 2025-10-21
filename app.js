// app.js — Express server for a DOT-style trucker logbook (GAME TIME ONLY)
// This server renders a DOT-style daily log that uses the game's absolute time (game.time)
// from the ETS2/ATS Telemetry Web Server. No IRL time math or extrapolation is performed.

// ====== Standard Node/Express imports ======
import express from "express";               // Web framework for routing and views
import path from "path";                     // Path utilities
import { fileURLToPath } from "url";         // Convert import.meta.url to a file path
import morgan from "morgan";                 // HTTP request logger for development

// fs-extra is CommonJS; import default then destructure what we need
import fsExtra from "fs-extra";              // File IO helpers (CJS default import)
const { readJSON, writeJSON, ensureDir, pathExists } = fsExtra;

import { request } from "undici";            // Modern HTTP client for telemetry fetches

// ====== Resolve __dirname in ESM ======
const __filename = fileURLToPath(import.meta.url); // Absolute path to this file
const __dirname = path.dirname(__filename);       // Directory containing this file

// ====== App + basic config ======
const app = express();                       // Create the Express app
const PORT = process.env.PORT || 3000;       // Server port (not the telemetry port)

// Use EJS templates that live in ./views
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Serve static files (JS/CSS) from ./public
app.use("/public", express.static(path.join(__dirname, "public")));

// Log requests in dev format
app.use(morgan("dev"));

// Parse form posts and JSON bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ====== Local JSON storage paths ======
const DATA_DIR = path.join(__dirname, "data");              // ./data
const FILE_SETTINGS = path.join(DATA_DIR, "app_settings.json");  // telemetry URL + driver display name
const FILE_DRIVERS = path.join(DATA_DIR, "drivers.json");       // driver list + active driver
const FILE_DUTY_EVENTS = path.join(DATA_DIR, "duty_events.json");   // duty event history

// Ensure data directory and seed JSON files if missing
await ensureDir(DATA_DIR);

if (!(await pathExists(FILE_SETTINGS))) {
    await writeJSON(FILE_SETTINGS, {
        telemetry_url: "http://localhost:25555/api/ets2/telemetry",     // Default telemetry endpoint
        driver_name: "Driver Name"                                       // Display name only
    }, { spaces: 2 });
}

if (!(await pathExists(FILE_DRIVERS))) {
    await writeJSON(FILE_DRIVERS, {
        activeDriverId: "default",
        drivers: [{ id: "default", name: "Driver Name" }]
    }, { spaces: 2 });
}

if (!(await pathExists(FILE_DUTY_EVENTS))) {
    await writeJSON(FILE_DUTY_EVENTS, [], { spaces: 2 });
}

// ====== In-memory telemetry cache (for last successful payload) ======
let LAST_TELEMETRY = null; // We keep the last JSON so UI can still render if a poll fails

// ====== Tiny helpers to load/save JSON ======
async function loadSettings() { return readJSON(FILE_SETTINGS); }
async function saveSettings(s) { return writeJSON(FILE_SETTINGS, s, { spaces: 2 }); }
async function loadDrivers() { return readJSON(FILE_DRIVERS); }
async function saveDrivers(d) { return writeJSON(FILE_DRIVERS, d, { spaces: 2 }); }
async function loadEvents() { return readJSON(FILE_DUTY_EVENTS); }
async function saveEvents(a) { return writeJSON(FILE_DUTY_EVENTS, a, { spaces: 2 }); }

// ====== Game Time helpers (NO IRL time logic) ======

/** Split ISO "0001-01-08T21:09:00Z" → { date: "0001-01-08", time: "21:09" } (kept in UTC) */
function splitGameIso(iso) {
    if (!iso || typeof iso !== "string" || iso.length < 16) {
        return { date: "0001-01-01", time: "00:00" };
    }
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** Lexicographic compare for zero-padded ISO Z strings (works for chronological order) */
function cmpGameIso(a, b) { return String(a).localeCompare(String(b)); }

/** Parse game-time ISO to JS Date (UTC) for arithmetic only */
function toJsDate(iso) { return new Date(iso); }

/** Minutes between two game-time ISOs, clamped ≥ 0 */
function minutesBetween(startIso, endIso) {
    const a = toJsDate(startIso).getTime();
    const b = toJsDate(endIso).getTime();
    const diffMs = Math.max(0, b - a);
    return Math.floor(diffMs / 60000);
}

/** Midnight (start) ISO for a game date YYYY-MM-DD */
function isoAtMidnight(gameYmd) { return `${gameYmd}T00:00:00Z`; }

/** End-of-day ISO (i.e., next midnight) for a game date YYYY-MM-DD */
function isoAtEndOfDay(gameYmd) {
    const d0 = new Date(`${gameYmd}T00:00:00Z`);
    const d1 = new Date(d0.getTime() + 24 * 60 * 60 * 1000);
    return d1.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Build daily segments for a specific game date.
 * If cutoffIso is passed (e.g., "now" for today), segments are trimmed to that cutoff (no future bars).
 * Returns: [{ status, startIso, endIso }]
 */
function buildDaySegments(allEvents, activeDriverId, gameYmd, cutoffIso = null) {
    // Keep only this driver's events, sorted in time
    const events = allEvents
        .filter(e => e.driverId === activeDriverId)
        .sort((a, b) => cmpGameIso(a.gameTimeIso, b.gameTimeIso));

    // Figure out [dayStart, dayEnd)
    const dayStart = isoAtMidnight(gameYmd);
    let dayEnd = isoAtEndOfDay(gameYmd);

    // If we have a cutoff within the day, trim dayEnd to it
    if (cutoffIso && cmpGameIso(cutoffIso, dayEnd) < 0) {
        dayEnd = cutoffIso;
    }

    // Find the last event strictly before dayStart for carry-over status
    let lastBefore = null;
    for (const e of events) {
        if (cmpGameIso(e.gameTimeIso, dayStart) < 0) lastBefore = e; else break;
    }

    // Events that happen inside [dayStart, dayEnd)
    const todays = events.filter(e =>
        cmpGameIso(e.gameTimeIso, dayStart) >= 0 && cmpGameIso(e.gameTimeIso, dayEnd) < 0
    );

    // Start with carry-over or OFF if none
    const segments = [];
    let currentStatus = lastBefore ? lastBefore.status : "OFF";
    let currentStart = dayStart;

    for (const ev of todays) {
        const cutStart = cmpGameIso(ev.gameTimeIso, currentStart) > 0 ? ev.gameTimeIso : currentStart;
        if (cmpGameIso(cutStart, currentStart) > 0) {
            segments.push({ status: currentStatus, startIso: currentStart, endIso: cutStart });
        }
        currentStatus = ev.status;
        currentStart = ev.gameTimeIso;
    }

    // Close final segment to dayEnd (which may be "now" if today)
    if (cmpGameIso(currentStart, dayEnd) < 0) {
        segments.push({ status: currentStatus, startIso: currentStart, endIso: dayEnd });
    }

    return segments;
}

/**
 * Aggregate minutes by main HOS rows:
 *  - OFF row includes OFF + PC (Personal Conveyance counts as Off Duty)
 *  - SB row includes SB (Sleeper)
 *  - D  row includes D  (Driving)
 *  - ON row includes ON + YM (Yard Move counts as On Duty)
 * We still track YM and PC separately for sub-totals on the right column.
 */
function aggregateDurations(segments) {
    const totals = { OFF: 0, SB: 0, D: 0, ON: 0, YM: 0, PC: 0 };
    for (const seg of segments) {
        const mins = minutesBetween(seg.startIso, seg.endIso);
        if (seg.status === "YM") { totals.YM += mins; totals.ON += mins; continue; } // YM → ON
        if (seg.status === "PC") { totals.PC += mins; totals.OFF += mins; continue; } // PC → OFF
        if (totals.hasOwnProperty(seg.status)) totals[seg.status] += mins;             // OFF/SB/D/ON
    }
    return totals;
}

// ====== Telemetry fetching (no extrapolation) ======

/** Get telemetry JSON from the configured telemetry_url; cache and return. */
async function fetchTelemetry() {
    const { telemetry_url } = await loadSettings();
    try {
        const { body } = await request(telemetry_url, { method: "GET", headers: { "accept": "application/json" } });
        const json = await body.json();
        LAST_TELEMETRY = json;
        return json;
    } catch (err) {
        throw new Error(`Telemetry fetch failed: ${err.message}`);
    }
}

/** Try fetching telemetry; on failure, return last cached value (if any). */
async function getTelemetrySafe() {
    try { return await fetchTelemetry(); } catch { return LAST_TELEMETRY; }
}

// ====== Routes ======

// Redirect "/" to today's game date if telemetry is available
app.get("/", async (req, res) => {
    const telem = await getTelemetrySafe();
    if (telem && telem.game && telem.game.time) {
        const { date } = splitGameIso(telem.game.time);
        return res.redirect(`/log/${date}`);
    }
    return res.redirect("/log");
});

// Render a daily log by GAME DATE (YYYY-MM-DD). If date is missing, try telemetry's date.
app.get("/log/:date?", async (req, res) => {
    const settings = await loadSettings();
    const drivers = await loadDrivers();
    const events = await loadEvents();
    const telem = await getTelemetrySafe();

    // Pick which game date to show
    let gameDate = req.params.date;
    if (!gameDate && telem && telem.game && telem.game.time) {
        gameDate = splitGameIso(telem.game.time).date;
    }

    // If we still have no date (no telemetry running), render a blank state
    if (!gameDate) {
        return res.render("log", {
            settings,
            drivers,
            activeDriverId: drivers.activeDriverId,
            telem,
            gameDate: null,
            segments: [],
            events: [],
            durations: { OFF: 0, SB: 0, D: 0, ON: 0, YM: 0, PC: 0 },
            currentStatus: null
        });
    }

    // If viewing today's date, trim segments at the current game "now" so we never draw into the future
    const nowIso = telem && telem.game && telem.game.time ? telem.game.time : null;
    const nowDate = nowIso ? splitGameIso(nowIso).date : null;
    const cutoff = (nowIso && nowDate === gameDate) ? nowIso : null;

    // Compute segments + totals + "current status"
    const segments = buildDaySegments(events, drivers.activeDriverId, gameDate, cutoff);
    const durations = aggregateDurations(segments);
    const currentStatus = segments.length ? segments[segments.length - 1].status : "OFF";

    // Render the page
    return res.render("log", {
        settings,
        drivers,
        activeDriverId: drivers.activeDriverId,
        telem,
        gameDate,
        segments,
        events: events
            .filter(e => e.driverId === drivers.activeDriverId && e.gameTimeIso.startsWith(gameDate))
            .sort((a, b) => cmpGameIso(a.gameTimeIso, b.gameTimeIso)),
        durations,
        currentStatus
    });
});

// Small telemetry proxy for the front-end (keeps the cards fresh)
app.get("/api/telemetry", async (req, res) => {
    const data = await getTelemetrySafe();
    res.json({ ok: !!data, telemetry: data || null });
});

// Create a duty event at the CURRENT GAME TIME from telemetry
app.post("/api/event", async (req, res) => {
    const { status, note } = req.body;
    const drivers = await loadDrivers();
    const events = await loadEvents();
    const telem = await fetchTelemetry(); // pull live to get exact game.time

    if (!telem || !telem.game || !telem.game.time) {
        return res.status(503).json({ ok: false, error: "Telemetry not available (no game.time)." });
    }

    // Allow only known statuses (OFF, SB, D, ON, YM, PC)
    const ALLOWED = ["OFF", "SB", "D", "ON", "YM", "PC"];
    if (!ALLOWED.includes(String(status))) {
        return res.status(400).json({ ok: false, error: "Invalid status." });
    }

    // Build and save the event
    const ev = {
        driverId: drivers.activeDriverId,
        status: String(status),
        gameTimeIso: telem.game.time,                                      // ABSOLUTE game time
        odometerMi: telem.truck && typeof telem.truck.odometer === "number"
            ? telem.truck.odometer * 0.621371                                // km → miles
            : null,
        note: note ? String(note) : ""
    };

    events.push(ev);
    await saveEvents(events);

    return res.json({ ok: true, event: ev });
});

// Settings page
app.get("/settings", async (req, res) => {
    const settings = await loadSettings();
    const drivers = await loadDrivers();
    res.render("settings", { settings, drivers });
});

// Update settings (telemetry URL, driver display name, active driver)
app.post("/settings", async (req, res) => {
    const { telemetry_url, driver_name, activeDriverId } = req.body;
    const settings = await loadSettings();
    const drivers = await loadDrivers();

    settings.telemetry_url = String(telemetry_url || settings.telemetry_url).trim();
    settings.driver_name = String(driver_name || settings.driver_name).trim();
    await saveSettings(settings);

    if (activeDriverId && drivers.drivers.some(d => d.id === activeDriverId)) {
        drivers.activeDriverId = activeDriverId;
        await saveDrivers(drivers);
    }
    res.redirect("/settings");
});

// Add a new driver and make them active
app.post("/settings/add-driver", async (req, res) => {
    const { newDriverName } = req.body;
    if (!newDriverName || !newDriverName.trim()) return res.redirect("/settings");

    const drivers = await loadDrivers();
    const id = newDriverName.trim().toLowerCase().replace(/\s+/g, "-");
    if (!drivers.drivers.find(d => d.id === id)) {
        drivers.drivers.push({ id, name: newDriverName.trim() });
        drivers.activeDriverId = id;
        await saveDrivers(drivers);
    }
    res.redirect("/settings");
});

// ====== Start the server ======
app.listen(PORT, () => {
    console.log(`Logbook running on http://localhost:${PORT}`);
});
