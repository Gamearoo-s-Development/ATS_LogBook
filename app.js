// app.js — Express server for a DOT-style trucker logbook (GAME TIME ONLY)

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import morgan from "morgan";
import fsExtra from "fs-extra";
const { readJSON, writeJSON, ensureDir, pathExists } = fsExtra;
import { request } from "undici";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use(morgan("dev"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// === Local JSON storage
const DATA_DIR = path.join(__dirname, "data");
const FILE_SETTINGS = path.join(DATA_DIR, "app_settings.json");
const FILE_DRIVERS = path.join(DATA_DIR, "drivers.json");
const FILE_DUTY_EVENTS = path.join(DATA_DIR, "duty_events.json");

await ensureDir(DATA_DIR);
if (!(await pathExists(FILE_SETTINGS))) {
    await writeJSON(FILE_SETTINGS, { telemetry_url: "http://localhost:25555/api/ets2/telemetry", driver_name: "Driver Name" }, { spaces: 2 });
}
if (!(await pathExists(FILE_DRIVERS))) {
    await writeJSON(FILE_DRIVERS, { activeDriverId: "default", drivers: [{ id: "default", name: "Driver Name" }] }, { spaces: 2 });
}
if (!(await pathExists(FILE_DUTY_EVENTS))) {
    await writeJSON(FILE_DUTY_EVENTS, [], { spaces: 2 });
}

let LAST_TELEMETRY = null;

// === Helpers
async function loadSettings() { return readJSON(FILE_SETTINGS); }
async function saveSettings(s) { return writeJSON(FILE_SETTINGS, s, { spaces: 2 }); }
async function loadDrivers() { return readJSON(FILE_DRIVERS); }
async function saveDrivers(d) { return writeJSON(FILE_DRIVERS, d, { spaces: 2 }); }
async function loadEvents() { return readJSON(FILE_DUTY_EVENTS); }
async function saveEvents(a) { return writeJSON(FILE_DUTY_EVENTS, a, { spaces: 2 }); }

// === Game-time utils (NO IRL time math)
function splitGameIso(iso) { if (!iso || iso.length < 16) return { date: "0001-01-01", time: "00:00" }; return { date: iso.slice(0, 10), time: iso.slice(11, 16) }; }
function cmpGameIso(a, b) { return String(a).localeCompare(String(b)); }
function toJsDate(iso) { return new Date(iso); }
function minutesBetween(a, b) { return Math.floor(Math.max(0, toJsDate(b).getTime() - toJsDate(a).getTime()) / 60000); }
function isoAtMidnight(d) { return `${d}T00:00:00Z`; }
function isoAtEndOfDay(d) { const d0 = new Date(`${d}T00:00:00Z`); const d1 = new Date(d0.getTime() + 24 * 60 * 60 * 1000); return d1.toISOString().replace(/\.\d{3}Z$/, "Z"); }

/** Build day segments for graph; if cutoffIso provided (today), trim to it (no future bars) */
function buildDaySegments(allEvents, driverId, gameYmd, cutoffIso = null) {
    const events = allEvents.filter(e => e.driverId === driverId).sort((a, b) => cmpGameIso(a.gameTimeIso, b.gameTimeIso));
    const dayStart = isoAtMidnight(gameYmd);
    let dayEnd = isoAtEndOfDay(gameYmd);
    if (cutoffIso && cmpGameIso(cutoffIso, dayEnd) < 0) dayEnd = cutoffIso;

    let lastBefore = null;
    for (const e of events) { if (cmpGameIso(e.gameTimeIso, dayStart) < 0) lastBefore = e; else break; }

    const todays = events.filter(e => cmpGameIso(e.gameTimeIso, dayStart) >= 0 && cmpGameIso(e.gameTimeIso, dayEnd) < 0);

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
    if (cmpGameIso(currentStart, dayEnd) < 0) {
        segments.push({ status: currentStatus, startIso: currentStart, endIso: dayEnd });
    }
    return segments;
}

/** Totals: PC counts as OFF; YM counts as ON (but both tracked separately too) */
function aggregateDurations(segments) {
    const totals = { OFF: 0, SB: 0, D: 0, ON: 0, YM: 0, PC: 0 };
    for (const s of segments) {
        const m = minutesBetween(s.startIso, s.endIso);
        if (s.status === "YM") { totals.YM += m; totals.ON += m; continue; }
        if (s.status === "PC") { totals.PC += m; totals.OFF += m; continue; }
        if (totals.hasOwnProperty(s.status)) totals[s.status] += m;
    }
    return totals;
}

// === Telemetry fetch
async function fetchTelemetry() {
    const { telemetry_url } = await loadSettings();
    const { body } = await request(telemetry_url, { method: "GET", headers: { "accept": "application/json" } });
    const json = await body.json();
    LAST_TELEMETRY = json;
    return json;
}
async function getTelemetrySafe() { try { return await fetchTelemetry(); } catch { return LAST_TELEMETRY; } }

// Helpers to pick first non-empty string & build "City, State"
function pick(...cands) {
    for (const v of cands) {
        if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
}
function defaultLocationFromTelem(telem) {
    if (!telem) return "";
    const nav = telem.navigation || {};
    const truckPlace = (telem.truck && telem.truck.place) ? telem.truck.place : {};
    const job = telem.job || {};

    const city = pick(
        nav.city, nav.cityName, nav.currentCity, nav.destinationCity, nav.nextWaypointCity,
        truckPlace.city, job.destinationCity, job.sourceCity
    );
    const state = pick(
        nav.state, nav.stateCode, nav.region, nav.province, nav.countryCode,
        truckPlace.state, truckPlace.stateCode, truckPlace.countryCode
    );

    if (city && state) return `${city}, ${state}`;
    if (city) return city;
    if (state) return state;
    return "";
}

// === Routes
app.get("/", async (req, res) => {
    const telem = await getTelemetrySafe();
    if (telem?.game?.time) {
        const { date } = splitGameIso(telem.game.time);
        return res.redirect(`/log/${date}`);
    }
    return res.redirect("/log");
});

app.get("/log/:date?", async (req, res) => {
    const settings = await loadSettings();
    const drivers = await loadDrivers();
    const events = await loadEvents();
    const telem = await getTelemetrySafe();

    let gameDate = req.params.date;
    if (!gameDate && telem?.game?.time) gameDate = splitGameIso(telem.game.time).date;

    if (!gameDate) {
        return res.render("log", { settings, drivers, activeDriverId: drivers.activeDriverId, telem, gameDate: null, segments: [], events: [], durations: { OFF: 0, SB: 0, D: 0, ON: 0, YM: 0, PC: 0 }, currentStatus: null, initialLoc: defaultLocationFromTelem(telem) });
    }

    const nowIso = telem?.game?.time ?? null;
    const nowDate = nowIso ? splitGameIso(nowIso).date : null;
    const cutoff = (nowIso && nowDate === gameDate) ? nowIso : null;

    const segments = buildDaySegments(events, drivers.activeDriverId, gameDate, cutoff);
    const durations = aggregateDurations(segments);
    const currentStatus = segments.length ? segments[segments.length - 1].status : "OFF";

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
        currentStatus,
        initialLoc: defaultLocationFromTelem(telem)
    });
});

// "connected" = telemetry.game.connected (game open), also expose "paused".
app.get("/api/telemetry", async (req, res) => {
    try {
        const data = await fetchTelemetry(); // live
        const connected = Boolean(data?.game?.connected);
        const paused = (typeof data?.game?.paused === "boolean") ? data.game.paused : null;
        res.json({ ok: true, fresh: true, connected, paused, telemetry: data });
    } catch (e) {
        res.json({ ok: false, fresh: false, connected: false, paused: null, telemetry: null, error: "Telemetry unreachable" });
    }
});

app.post("/api/event", async (req, res) => {
    const { status, activity, location } = req.body; // note: no 'note'
    const drivers = await loadDrivers();
    const events = await loadEvents();
    let telem;
    try {
        telem = await fetchTelemetry();
    } catch {
        return res.status(503).json({ ok: false, error: "Telemetry not available (no game.time)." });
    }
    if (!telem?.game?.time) return res.status(503).json({ ok: false, error: "Telemetry not available (no game.time)." });

    const ALLOWED = ["OFF", "SB", "D", "ON", "YM", "PC"];
    if (!ALLOWED.includes(String(status))) return res.status(400).json({ ok: false, error: "Invalid status." });

    const loc = (location && String(location).trim()) ? String(location).trim() : defaultLocationFromTelem(telem);

    const ev = {
        driverId: drivers.activeDriverId,
        status: String(status),
        gameTimeIso: telem.game.time,
        odometerMi: (telem.truck && typeof telem.truck.odometer === "number") ? telem.truck.odometer * 0.621371 : null,
        activity: activity ? String(activity) : "",
        location: loc
    };
    events.push(ev);
    await saveEvents(events);
    res.json({ ok: true, event: ev });
});

app.get("/settings", async (req, res) => {
    const settings = await loadSettings();
    const drivers = await loadDrivers();
    res.render("settings", { settings, drivers });
});
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
app.post("/settings/add-driver", async (req, res) => {
    const { newDriverName } = req.body;
    if (!newDriverName?.trim()) return res.redirect("/settings");
    const drivers = await loadDrivers();
    const id = newDriverName.trim().toLowerCase().replace(/\s+/g, "-");
    if (!drivers.drivers.find(d => d.id === id)) {
        drivers.drivers.push({ id, name: newDriverName.trim() });
        drivers.activeDriverId = id;
        await saveDrivers(drivers);
    }
    res.redirect("/settings");
});

app.listen(PORT, () => console.log(`Logbook running on http://localhost:${PORT}`));
