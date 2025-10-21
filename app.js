// app.js — Express server for a DOT-style trucker logbook (GAME TIME ONLY)

// ====== Standard Node/Express imports ======
import express from "express";               // Web framework for routing and views
import path from "path";                     // Path utilities
import { fileURLToPath } from "url";         // To convert import.meta.url to file path
import morgan from "morgan";                 // HTTP request logger (dev friendly)

// fs-extra is CommonJS → import default, then destructure named helpers
import fsExtra from "fs-extra";              // File IO helpers (CJS default import)
const { readJSON, writeJSON, ensureDir, pathExists } = fsExtra;

import { request } from "undici";            // Modern HTTP client to fetch telemetry

// ====== Resolve __dirname in ESM ======
const __filename = fileURLToPath(import.meta.url); // Current file's absolute path
const __dirname = path.dirname(__filename);       // Current dir path

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
const DATA_DIR = path.join(__dirname, "data");             // ./data
const FILE_SETTINGS = path.join(DATA_DIR, "app_settings.json"); // telemetry URL, driver etc.
const FILE_DRIVERS = path.join(DATA_DIR, "drivers.json");      // driver list + active driver
const FILE_DUTY_EVENTS = path.join(DATA_DIR, "duty_events.json");  // duty events history

// ====== Boot-time ensure data directory + seed files if missing ======
await ensureDir(DATA_DIR);                                           // Make sure ./data exists

// Initialize app_settings.json with a default telemetry URL if missing
if (!(await pathExists(FILE_SETTINGS))) {
    await writeJSON(FILE_SETTINGS, {
        telemetry_url: "http://localhost:25555/api/ets2/telemetry",      // Default ETS2/ATS telemetry API
        driver_name: "Driver Name"                                       // Display-only driver name
    }, { spaces: 2 });
}

// Initialize drivers.json with a default active driver if missing
if (!(await pathExists(FILE_DRIVERS))) {
    await writeJSON(FILE_DRIVERS, {
        activeDriverId: "default",
        drivers: [{ id: "default", name: "Driver Name" }]
    }, { spaces: 2 });
}

// Initialize duty_events.json as empty array if missing
if (!(await pathExists(FILE_DUTY_EVENTS))) {
    await writeJSON(FILE_DUTY_EVENTS, [], { spaces: 2 });
}

// ====== In-memory telemetry cache (latest pull), no IRL extrapolation ======
let LAST_TELEMETRY = null; // Will hold the latest telemetry JSON from the server

// ====== Small helpers to load/save local JSON ======
async function loadSettings() { return readJSON(FILE_SETTINGS); }
async function saveSettings(s) { return writeJSON(FILE_SETTINGS, s, { spaces: 2 }); }
async function loadDrivers() { return readJSON(FILE_DRIVERS); }
async function saveDrivers(d) { return writeJSON(FILE_DRIVERS, d, { spaces: 2 }); }
async function loadEvents() { return readJSON(FILE_DUTY_EVENTS); }
async function saveEvents(a) { return writeJSON(FILE_DUTY_EVENTS, a, { spaces: 2 }); }

// ====== Game Time helpers (no IRL computations) ======

/** Split "0001-01-08T21:09:00Z" → { date: "0001-01-08", time: "21:09" } */
function splitGameIso(iso) {
    if (!iso || typeof iso !== "string" || iso.length < 16) {
        return { date: "0001-01-01", time: "00:00" };
    }
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** Lexicographic compare for zero-padded ISO Z strings */
function cmpGameIso(a, b) { return String(a).localeCompare(String(b)); }

/** Parse game-time ISO to JS Date (UTC) — for math only */
function toJsDate(iso) { return new Date(iso); }

/** Minutes between two game-time ISO strings (clamped ≥ 0) */
function minutesBetween(startIso, endIso) {
    const a = toJsDate(startIso).getTime();
    const b = toJsDate(endIso).getTime();
    const diffMs = Math.max(0, b - a);
    return Math.floor(diffMs / 60000);
}

/** Midnight ISO for a game date YYYY-MM-DD */
function isoAtMidnight(gameYmd) { return `${gameYmd}T00:00:00Z`; }

/** End-of-day ISO (next midnight) for a game date YYYY-MM-DD */
function isoAtEndOfDay(gameYmd) {
    const d0 = new Date(`${gameYmd}T00:00:00Z`);
    const d1 = new Date(d0.getTime() + 24 * 60 * 60 * 1000);
    return d1.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Build the duty segments for a given game date (YYYY-MM-DD).
 * Returns [{ status, startIso, endIso }, ...] limited to that day.
 */
function buildDaySegments(allEvents, activeDriverId, gameYmd) {
    const events = allEvents
        .filter(e => e.driverId === activeDriverId)
        .sort((a, b) => cmpGameIso(a.gameTimeIso, b.gameTimeIso));

    const dayStart = isoAtMidnight(gameYmd);
    const dayEnd = isoAtEndOfDay(gameYmd);

    // Find last event strictly before dayStart → carry-over status
    let lastBefore = null;
    for (const e of events) {
        if (cmpGameIso(e.gameTimeIso, dayStart) < 0) lastBefore = e; else break;
    }

    // Events that occur within this day
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

    // Close out to end-of-day
    if (cmpGameIso(currentStart, dayEnd) < 0) {
        segments.push({ status: currentStatus, startIso: currentStart, endIso: dayEnd });
    }

    return segments;
}

/** Aggregate minutes per row: OFF/SB/D/ON (YM/PC count into ON, but tracked separately too) */
function aggregateDurations(segments) {
    const totals = { OFF: 0, SB: 0, D: 0, ON: 0, YM: 0, PC: 0 };
    for (const seg of segments) {
        const mins = minutesBetween(seg.startIso, seg.endIso);
        if (seg.status === "YM") { totals.YM += mins; totals.ON += mins; continue; }
        if (seg.status === "PC") { totals.PC += mins; totals.ON += mins; continue; }
        if (totals.hasOwnProperty(seg.status)) totals[seg.status] += mins;
    }
    return totals;
}

// ====== Telemetry fetching (NO IRL extrapolation; just poll the real HTTP endpoint) ======

/** Pull telemetry from configured telemetry_url; cache and return */
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

/** Get telemetry if possible; fall back to last cached on failure */
async function getTelemetrySafe() {
    try { return await fetchTelemetry(); } catch { return LAST_TELEMETRY; }
}

// ====== Routes ======

// Redirect to today's game date if telemetry provides it
app.get("/", async (req, res) => {
    const telem = await getTelemetrySafe();
    if (telem && telem.game && telem.game.time) {
        const { date } = splitGameIso(telem.game.time);
        return res.redirect(`/log/${date}`);
    }
    return res.redirect("/log");
});

// Log view for a GAME DATE (YYYY-MM-DD). If absent, try telemetry date.
app.get("/log/:date?", async (req, res) => {
    const settings = await loadSettings();
    const drivers = await loadDrivers();
    const events = await loadEvents();
    const telem = await getTelemetrySafe();

    // Decide which game date to render
    let gameDate = req.params.date;
    if (!gameDate && telem && telem.game && telem.game.time) {
        gameDate = splitGameIso(telem.game.time).date;
    }

    if (!gameDate) {
        // No telemetry; show blank state
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

    // Build graph segments + totals for this date
    const segments = buildDaySegments(events, drivers.activeDriverId, gameDate);
    const durations = aggregateDurations(segments);

    // Current status for this date = status of the last segment (used to highlight a button)
    const currentStatus = segments.length ? segments[segments.length - 1].status : "OFF";

    // Render template with everything needed
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

// Telemetry proxy (for the small UI refresher)
app.get("/api/telemetry", async (req, res) => {
    const data = await getTelemetrySafe();
    res.json({ ok: !!data, telemetry: data || null });
});

// Create a new duty event at current GAME TIME
app.post("/api/event", async (req, res) => {
    const { status, note } = req.body;
    const drivers = await loadDrivers();
    const events = await loadEvents();
    const telem = await fetchTelemetry(); // live call to get exact game.time

    if (!telem || !telem.game || !telem.game.time) {
        return res.status(503).json({ ok: false, error: "Telemetry not available (no game.time)." });
    }

    const ALLOWED = ["OFF", "SB", "D", "ON", "YM", "PC"];
    if (!ALLOWED.includes(String(status))) {
        return res.status(400).json({ ok: false, error: "Invalid status." });
    }

    const ev = {
        driverId: drivers.activeDriverId,
        status: String(status),
        gameTimeIso: telem.game.time,
        odometerMi: telem.truck && typeof telem.truck.odometer === "number"
            ? telem.truck.odometer * 0.621371
            : null,
        note: note ? String(note) : ""
    };

    events.push(ev);
    await saveEvents(events);

    return res.json({ ok: true, event: ev });
});

// Settings view
app.get("/settings", async (req, res) => {
    const settings = await loadSettings();
    const drivers = await loadDrivers();
    res.render("settings", { settings, drivers });
});

// Settings update
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

// Add driver
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

// ====== Start server ======
app.listen(PORT, () => {
    console.log(`Logbook running on http://localhost:${PORT}`);
});
