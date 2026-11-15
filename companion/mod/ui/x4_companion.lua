--[[
x4_companion.lua - X4 Companion bridge (v1.1).

v1.1: map parity data (game icon id "ic" per object, own radar range "rr", mission-target flag,
the game map's own colours in a "theme" message, plotted course + autopilot target, order queue
points of a selected own ship), gate list via the player's blackboard (one event instead of one
per gate), cost measurement that works without QueryPerformanceCounter (engine-call count "ops").

Streams game data to the local companion server (tools\x4companion) as one JSON object per
pipe message ("\n"-terminated) through the SirNukes Mod Support APIs named pipe
\\.\pipe\x4companion, and reads a small, allow-listed set of commands back from the same pipe.

Channels (each its own interval, time-sliced, cost-measured, auto-throttled):
  player   0.25 s  name, credits, ship hull/shield/speed, target, sector, game time, paused
  galaxy   60 s    known clusters/sectors (offsets, owner, discovered resources) - sent on change
  gates    on demand  MD enumerates jump gates (md\x4_companion_gates.xml), Lua resolves them
  theme    30 s    the game map's colours (GetHoloMapColors) + UI colour mappings, sent on change
  sector   1 s     objects the player sees in the current sector and in one "watched" sector
  property 4 s     all player ships + stations, diffed (only changed entries are sent)
  logbook  2 s     new logbook entries per category (incremental)
  ticker   1 s     on-screen notification history (incremental)
  messages 5 s     inbox (high/low priority), sent on change
  missions 3 s     accepted missions with objective text and reward
  offers   10 s    current mission offers
  factions 20 s    relation to the player, licences - sent on change
  economy  30 s    player account transactions of the last game hour (summary + top entries)
  stats    2 s     per-channel cost (avg/max ms), errors, disabled sources

Safety: every game/API call goes through S() (pcall, per-source error counter, the source is
switched off after CFG.src_consec consecutive or CFG.src_total total failures) and every
channel step runs inside pcall (channel switched off after CFG.ch_err_limit failures). Nothing
can raise into the game UI. Per frame the scheduler stops stepping channels once
CFG.frame_budget_ms is used (QueryPerformanceCounter timing, fallback os.clock), so big lists
are always time-sliced. A channel whose average cost exceeds its budget gets a longer interval
automatically (and recovers when cheap again).

Logging: normal information goes to UIInfo/UIWarning (Lua Log API, optional) - never as
DebugError. Without the Lua Log API exactly one start line is written with DebugError; after
that DebugError is used only for real errors, rate limited (one line per kind per 30 s).

Every game function used here is listed with the vanilla 9.00 file:line where the same call
is declared/used in API-REFERENCE.md (tools\x4companion). The most important ones:
  ffi cdefs: GetPlayerID menu_docked.lua:104 | GetPlayerOccupiedShipID menu_crafting.lua:25
    GetContextByClass menu_docked.lua:78 | GetObjectPositionInSector helper.lua:366
    GetComponentName helper.lua:315 | GetComponentClass menu_map.lua:587
    IsComponentClass menu_docked.lua:123 | IsGamePaused helptext.lua:9
    GetPlayerName menu_playerinfo.lua:238 | GetPlayerFactionName menu_playerinfo.lua:233
    GetCurrentGameTime menu_crafting.lua:22 | GetSofttarget2 menu_docked.lua:110
    GetDefensibleSpeeds menu_map.lua:615 | GetDistanceBetween menu_interactmenu.lua:189
    GetPositionalOffset menu_mapeditor.lua:91 | Get(Num)DiscoveredSectorResources menu_encyclopedia.lua:100/111
    Get(Num)AllFactionShips/Stations menu_playerinfo.lua:185/186/205/206
    GetNumOrders/GetOrders menu_map.lua:715/747 | GetOrderQueueCurrentIdx menu_map.lua:745
    GetDefaultOrder menu_map.lua:607 | GetOrderDefinition menu_map.lua:739
    GetNumStationModules helper.lua:359 | GetWorkForceInfo menu_map.lua:824
    Get(Num)TickerCache menu_playerinfo.lua:220/248 | Get(Num)Messages menu_playerinfo.lua:203/213
    Get(Num)CurrentMissionOffers menu_map.lua:604/693 | GetActiveMissionID menu_map.lua:553
    GetUIRelationName menu_diplomacy.lua:169 | Get(Num)TransactionLog helper.lua:384/361
    IsInfoUnlockedForPlayer menu_map.lua:855
  commands: SetSofttarget menu_map.lua:983 (use: mycu_map_hotkeys map_hotkeys.lua:159)
    SetGuidance menu_map.lua:937 (use: menu_playerinfo.lua:852-870)
    SetFocusMapComponent menu_map.lua:933 (use: menu_map.lua:2727)
    OpenMenu("MapMenu", {0, 0, true, obj}) (use: menu_playerinfo.lua:856, params menu_map.lua:29435)
    orders: menu_interactmenu.lua:831-851 (orderMoveWait), :883-915 (orderRemove)
  Lua globals: GetComponentData, GetContainedObjectsByOwner (menu_map.lua:8225; with a space
    argument menu_platformundock.lua:121, confirmed in the real game by v0), GetClusters/GetSectors
    (menu_map.lua:20885), GetPlayerMoney (menu_diplomacy.lua:2572), GetLibrary("factions")
    (menu_diplomacy.lua:1187), GetFactionData (:1198), GetOwnLicences (:1200), HasLicence (:1780),
    GetUIRelation (:1264), GetNumLogbook/GetLogbook (menu_playerinfo.lua:2830/2909),
    GetNumMissions/GetMissionDetails/GetMissionObjective/GetActiveMission (menu_map.lua:18856,
    18679, 18686, 18698), GetMissionOfferDetails (menu_map.lua:18512), GetCommander
    (menu_map.lua:8272), GetWareData, IsValidComponent (menu_map.lua:4357), AddUITriggeredEvent
    (menu_diplomacy.lua:381), RegisterEvent, SetScript, GetCurRealTime, DebugError.
  SN 1.95: Pipes.Schedule_Write / Schedule_Read (pipes.lua:161 / 127), Time.Register_NewFrame_Callback.
  Native Hotkey API 8.00.09: RegisterEvent("HotkeyApi.Register_Request") + HotkeyApi.RegisterAction
    (hotkey_api.lua:589-617).
]]

local ffi = require("ffi")
-- Test hook: the offline test harness (tools\x4companion\tests\lua_harness.py, LuaJIT via lupa)
-- injects a mock C table here. In the game the global is nil and ffi.C is used.
local C = rawget(_G, "__X4COMPANION_TEST_C") or ffi.C
local K = ffi.C   -- Windows kernel32 (QueryPerformanceCounter) - not a game function

local MOD = "x4_companion"
local VERSION = "110"

-------------------------------------------------------------------------------
-- ffi declarations: only what is still missing. Vanilla menus declare all of these
-- (identical text copied from the files cited above); declaring a type only when ffi.typeof
-- fails means we never shadow the game's own declarations.

local function deftype(name, decl)
    if not pcall(ffi.typeof, name) then pcall(ffi.cdef, decl) end
end
local function deffn(decl) pcall(ffi.cdef, decl) end

deftype("UniverseID", "typedef uint64_t UniverseID;")
deftype("MissionID", "typedef uint64_t MissionID;")
deftype("MessageID", "typedef uint64_t MessageID;")
deftype("TickerCacheID", "typedef uint64_t TickerCacheID;")
deftype("UIPosRot", [[typedef struct { float x; float y; float z; float yaw; float pitch; float roll; } UIPosRot;]])
deftype("SofttargetDetails2", [[typedef struct { UniverseID softtargetID; const char* softtargetConnectionName; uint32_t messageID; } SofttargetDetails2;]])
deftype("SpeedInfo", [[typedef struct { float speed; float boostspeed; float travelspeed; } SpeedInfo;]])
deftype("WareYield", [[typedef struct { const char* ware; int32_t current; int32_t max; } WareYield;]])
deftype("Order", [[typedef struct { size_t queueidx; const char* state; const char* statename; const char* orderdef; size_t actualparams; bool enabled; bool isinfinite; bool issyncpointreached; bool istemporder; } Order;]])
deftype("OrderDefinition", [[typedef struct { const char* id; const char* name; const char* icon; const char* description; const char* category; const char* categoryname; bool infinite; uint32_t requiredSkill; } OrderDefinition;]])
deftype("WorkForceInfo", [[typedef struct { uint32_t current; uint32_t capacity; uint32_t optimal; uint32_t available; uint32_t maxavailable; double timeuntilnextupdate; } WorkForceInfo;]])
deftype("TickerCacheEntry", [[typedef struct { TickerCacheID id; double time; const char* category; const char* title; const char* text; } TickerCacheEntry;]])
deftype("MessageInfo", [[typedef struct { MessageID id; double time; const char* category; const char* title; const char* text; const char* source; UniverseID sourcecomponent; const char* interaction; UniverseID interactioncomponent; const char* interactiontext; const char* interactionshorttext; const char* cutscenekey; const char* entityname; const char* factionname; int64_t money; int64_t bonus; bool highlighted; bool isread; } MessageInfo;]])
deftype("TransactionLogEntry", [[typedef struct { double time; int64_t money; int64_t entryid; const char* eventtype; const char* eventtypename; UniverseID partnerid; const char* partnername; const char* partneridcode; int64_t tradeentryid; const char* tradeeventtype; const char* tradeeventtypename; UniverseID buyerid; UniverseID sellerid; const char* ware; uint32_t amount; int64_t price; bool complete; } TransactionLogEntry;]])
deftype("RelationRangeInfo", [[typedef struct { const char* name; const char* colorid; } RelationRangeInfo;]])
-- v1.2 resource areas: menu_map.lua:464 (YieldInfo); Coord3D as passed in menu_interactmenu.lua:5889-5892
deftype("Coord3D", [[typedef struct { float x; float y; float z; } Coord3D;]])
deftype("YieldInfo", [[typedef struct { const char* wareid; int32_t amount; } YieldInfo;]])
-- v1.2 local highways: menu_mapeditor.lua:40-46 (SplineData), :77 / :84 (GetHighwaySplinePoints / GetNumHighwaySplinePoints)
deftype("SplineData", [[typedef struct { Coord3D offset; Coord3D tangent; float weight; float inlength; float outlength; } SplineData;]])

deffn("UniverseID GetPlayerID(void);")
deffn("UniverseID GetPlayerOccupiedShipID(void);")
deffn("UniverseID GetContextByClass(UniverseID componentid, const char* classname, bool includeself);")
deffn("UIPosRot GetObjectPositionInSector(UniverseID objectid);")
deffn("const char* GetComponentName(UniverseID componentid);")
deffn("const char* GetComponentClass(UniverseID componentid);")
deffn("bool IsComponentClass(UniverseID componentid, const char* classname);")
deffn("bool IsGamePaused(void);")
deffn("const char* GetPlayerName(void);")
deffn("const char* GetPlayerFactionName(bool userawname);")
deffn("double GetCurrentGameTime(void);")
deffn("SofttargetDetails2 GetSofttarget2(void);")
deffn("SpeedInfo GetDefensibleSpeeds(UniverseID defensibleid);")
deffn("float GetDistanceBetween(UniverseID component1id, UniverseID component2id);")
deffn("UIPosRot GetPositionalOffset(UniverseID positionalid, UniverseID spaceid);")
deffn("uint32_t GetNumDiscoveredSectorResources(UniverseID sectorid);")
deffn("uint32_t GetDiscoveredSectorResources(WareYield* result, uint32_t resultlen, UniverseID sectorid);")
deffn("uint32_t GetNumMineablesAtSectorPos(UniverseID sectorid, Coord3D position);")
deffn("uint32_t GetMineablesAtSectorPos(YieldInfo* result, uint32_t resultlen, UniverseID sectorid, Coord3D position);")
deffn("uint32_t GetNumHighwaySplinePoints(UniverseID highwayid);")
deffn("uint32_t GetHighwaySplinePoints(SplineData* result, uint32_t resultlen, UniverseID highwayid);")
deffn("uint32_t GetNumAllFactionShips(const char* factionid);")
deffn("uint32_t GetAllFactionShips(UniverseID* result, uint32_t resultlen, const char* factionid);")
deffn("uint32_t GetNumAllFactionStations(const char* factionid);")
deffn("uint32_t GetAllFactionStations(UniverseID* result, uint32_t resultlen, const char* factionid);")
deffn("uint32_t GetNumOrders(UniverseID controllableid);")
deffn("uint32_t GetOrders(Order* result, uint32_t resultlen, UniverseID controllableid);")
deffn("size_t GetOrderQueueCurrentIdx(UniverseID controllableid);")
deffn("bool GetDefaultOrder(Order* result, UniverseID controllableid);")
deffn("bool GetOrderDefinition(OrderDefinition* result, const char* orderdef);")
deffn("uint32_t GetNumStationModules(UniverseID stationid, bool includeconstructions, bool includewrecks);")
deffn("WorkForceInfo GetWorkForceInfo(UniverseID containerid, const char* raceid);")
deffn("uint32_t GetNumTickerCache(const char* categoryname);")
deffn("uint32_t GetTickerCache(TickerCacheEntry* result, uint32_t resultlen, size_t start, size_t count, const char* categoryname);")
deffn("uint32_t GetNumMessages(const char* categoryname, bool );")
deffn("uint32_t GetMessages(MessageInfo* result, uint32_t resultlen, size_t start, size_t count, const char* categoryname);")
deffn("uint32_t GetNumCurrentMissionOffers(bool showninbbs);")
deffn("uint32_t GetCurrentMissionOffers(uint64_t* result, uint32_t resultlen, bool showninbbs);")
deffn("uint64_t GetActiveMissionID();")
deffn("RelationRangeInfo GetUIRelationName(const char* fromfactionid, const char* tofactionid);")
deffn("uint32_t GetNumTransactionLog(UniverseID componentid, double starttime, double endtime);")
deffn("uint32_t GetTransactionLog(TransactionLogEntry* result, uint32_t resultlen, UniverseID componentid, double starttime, double endtime);")
deffn("bool IsInfoUnlockedForPlayer(UniverseID componentid, const char* infostring);")
deffn("bool IsKnownToPlayer(UniverseID componentid);")
deffn("UniverseID GetPlayerControlledShipID(void);")
deffn("bool SetSofttarget(UniverseID componentid, const char*const connectionname);")
deffn("void SetGuidance(UniverseID componentid, UIPosRot offset);")
deffn("void EndGuidance(void);")
deffn("void SetFocusMapComponent(UniverseID holomapid, UniverseID componentid, bool resetplayerpan);")
deffn("bool IsOrderSelectableFor(const char* orderdefid, UniverseID controllableid);")
deffn("bool RemoveOrder(UniverseID controllableid, size_t idx, bool playercancelled, bool checkonly);")
deffn("void ResetOrderLoop(UniverseID controllableid);")
deffn("uint32_t CreateOrder(UniverseID controllableid, const char* orderid, bool default);")
deffn("bool EnablePlannedDefaultOrder(UniverseID controllableid, bool checkonly);")
-- Windows API (kernel32 is one of the libraries ffi.C binds on Windows; not a game function):
deffn("int QueryPerformanceCounter(int64_t* lpPerformanceCount);")
deffn("int QueryPerformanceFrequency(int64_t* lpFrequency);")

-------------------------------------------------------------------------------
-- Config

local CFG = {
    pipe_name       = "x4companion",   -- -> \\.\pipe\x4companion
    max_msg         = 48000,           -- bytes per pipe message (SN/Windows buffer is 64 KB)
    hello_every     = 2.0,             -- reconnect attempt period while disconnected (s)
    max_pending     = 24,              -- outstanding writes before droppable messages are dropped
    busy_reset      = 5.0,             -- a write callback missing this long -> assume lost
    frame_budget_ms = 0.5,             -- soft per-frame budget for all channel steps
    frame_budget_ops = 160,            -- same budget in engine calls when no high-resolution clock exists
    ops_per_ms = 150,                  -- budget conversion ms -> engine calls (~7 us per call, an estimate) for the ops-based throttle
    md_fallback     = 2,               -- MD ticks without a frame tick before MD drives a step
    src_consec      = 8,               -- a data source is switched off after N consecutive errors
    src_total       = 400,             --   ... or N errors in total
    ch_err_limit    = 12,              -- a channel is switched off after N step errors
    log_every       = 30.0,            -- rate limit per error kind (s)
    sector_max      = 700,             -- max objects per scanned sector
    log_initial     = 40,              -- logbook entries per category sent on (re)connect
    property_max    = 3500,            -- hard cap of ships + stations per property pass
    -- Commands the browser may send. Read-only/UI ones are on; orders are OFF by default -
    -- set to true here to allow them (the browser still needs its own "vezérlés" switch).
    allow = {
        resync = true, watch = true, reenable = true, details = true,
        openmap = true, select = true, target = true, guidance = true, guidance_end = true,
        stop = false, flyto = false,
    },
    hotkeys = true,                    -- register in-game hotkeys if the Native Hotkey API is present
}

-------------------------------------------------------------------------------
-- State

local W = {
    init_done = false, pipes = nil, pipes_tried = -1e9,
    connected = false, last_hello = -1e9, pending = 0, busy_since = 0,
    reading = false, session = 0,
    nsent = 0, nbytes = 0, ndrop = 0, nfail = 0, ncmd = 0,
    n_frame = 0, n_md = 0, md_since_frame = 0, last_frame_tick = -1e9,
    in_tick = false, watch = 0, src = "frame",
    last_log = {}, logged_start = false,
    frame_ms_sum = 0, frame_ms_max = 0, frame_n = 0,
    hk_registered = 0, hk_requested = false, hk_seen = false,
    gates_requested = -1e9, gates_pending = nil, gates_state = "none", gates = {}, gates_n = 0,
    sectorinfo = {},                   -- v1.2: sector id -> { core, cx, cz, contested } from MD
}

-------------------------------------------------------------------------------
-- Time

local function realtime()
    local ok, t = pcall(GetCurRealTime)
    if ok and type(t) == "number" then return t end
    return 0
end

-- High-resolution clock for the cost measurement. v1.0 in the real game reported "timer clock" and
-- every cost as 0: QueryPerformanceCounter was not reachable through ffi.C there, the UI
-- environment has no os.clock, and GetCurRealTime() is constant within one frame (all deltas 0).
-- Tried in this order, each inside pcall, the first one that really ticks wins:
--   1. ffi.C.QueryPerformanceCounter   (LuaJIT: ffi.C includes kernel32 on Windows)
--   2. ffi.load("kernel32").QueryPerformanceCounter   (explicit library handle)
--   3. os.clock                         (only if the environment has it)
--   4. none: "frame" - costs are then counted in engine calls (ops), see S() and schedule()
local qpc_buf, qpc_ms, qpc_lib = nil, nil, nil
local TIMER = "frame"
local function tryQpc(lib)
    local ok, good = pcall(function()
        local f = ffi.new("int64_t[1]")
        if lib.QueryPerformanceFrequency(f) == 0 or not (tonumber(f[0]) > 0) then return false end
        local a, b = ffi.new("int64_t[1]"), ffi.new("int64_t[1]")
        lib.QueryPerformanceCounter(a)
        for _ = 1, 2000 do end
        lib.QueryPerformanceCounter(b)
        if not (tonumber(b[0]) >= tonumber(a[0])) or tonumber(a[0]) <= 0 then return false end
        qpc_ms = 1000 / tonumber(f[0])
        qpc_buf = ffi.new("int64_t[1]")
        qpc_lib = lib
        return true
    end)
    return ok and good
end
if rawget(_G, "__X4COMPANION_TEST_NOQPC") then
    -- test hook: simulate the real game where neither QPC route worked
elseif tryQpc(K) then
    TIMER = "qpc"
else
    local okl, k32 = pcall(ffi.load, "kernel32")
    if okl and k32 and tryQpc(k32) then TIMER = "qpc-k32" end
end
local os_clock = nil
if not qpc_buf and not rawget(_G, "__X4COMPANION_TEST_NOQPC") and type(rawget(_G, "os")) == "table" and type(os.clock) == "function" then
    local ok, v = pcall(os.clock)
    if ok and type(v) == "number" then os_clock = os.clock; TIMER = "os.clock" end
end
local HIRES = TIMER ~= "frame"

local function hires()   -- milliseconds, monotonic (0-delta within a frame when TIMER == "frame")
    if qpc_buf then
        qpc_lib.QueryPerformanceCounter(qpc_buf)
        return tonumber(qpc_buf[0]) * qpc_ms
    end
    if os_clock then return os_clock() * 1000 end
    return realtime() * 1000
end

-------------------------------------------------------------------------------
-- Logging (never DebugError for information)

local function logline(level, kind, msg)
    local now = realtime()
    local last = W.last_log[kind]
    if last and (now - last) < CFG.log_every and now >= last then return end
    W.last_log[kind] = now
    local text = MOD .. ": " .. tostring(msg)
    local f
    if level == "info" then f = rawget(_G, "UIInfo")
    elseif level == "warn" then f = rawget(_G, "UIWarning")
    else f = rawget(_G, "UIError") end
    if type(f) == "function" then
        pcall(f, text)
    elseif level == "error" then
        pcall(DebugError, text)
    end
    -- info/warn without the Lua Log API: dropped on purpose (see header)
end
local function info(kind, msg) logline("info", kind, msg) end
local function warn(kind, msg) logline("warn", kind, msg) end
local function err(kind, msg) logline("error", kind, msg) end

-------------------------------------------------------------------------------
-- Data sources: pcall + per-source error counting / switch-off

local SRC = {}
local function finish(s, name, ok, ...)
    if ok then
        s.consec = 0
        return ...
    end
    s.err = s.err + 1
    s.consec = s.consec + 1
    s.last = tostring((...))
    if s.consec >= CFG.src_consec or s.err >= CFG.src_total then
        s.off = true
        err("off:" .. name, "data source '" .. name .. "' switched off after " .. s.err .. " errors: " .. s.last)
    else
        warn("src:" .. name, "data source '" .. name .. "' failed: " .. s.last)
    end
    return nil
end
local OPS = 0   -- engine calls made through S(): the clock-independent cost measure
local function S(name, fn, ...)
    local s = SRC[name]
    if not s then s = { err = 0, consec = 0, off = false }; SRC[name] = s end
    if s.off then return nil end
    OPS = OPS + 1
    return finish(s, name, pcall(fn, ...))
end

-------------------------------------------------------------------------------
-- Value helpers

local sfmt, sfind, sgsub, sbyte, ssub, tconcat = string.format, string.find, string.gsub, string.byte, string.sub, table.concat

-- any id shape (number, uint64 cdata "123ULL", LuaID "ID: 123") -> Lua number (0 = none)
local function to64(v)
    if v == nil then return 0 end
    local t = type(v)
    if t == "number" then return v end
    if t == "cdata" then
        local n = tonumber(v)
        if n then return n end
    end
    if t ~= "string" then
        local ok, n = pcall(ConvertIDTo64Bit, v)
        if ok and type(n) == "number" then return n end
        if ok and type(n) == "cdata" then return tonumber(n) or 0 end
    end
    local digits = string.match(tostring(v), "(%d+)")
    if digits then
        local ok, n = pcall(ConvertStringTo64Bit, digits)
        if ok and type(n) == "number" then return n end
        return tonumber(digits) or 0
    end
    return 0
end

local function idstr(v)
    local n = to64(v)
    if n == 0 then return nil end
    return sfmt("%.0f", n)
end

local function luaid(n)   -- 64-bit number -> LuaID (for Lua globals that want one)
    return ConvertStringToLuaID(sfmt("%.0f", n))
end

local function cstr(p)
    if p == nil then return nil end
    if type(p) == "string" then return p end
    local ok, s = pcall(ffi.string, p)
    if ok then return s end
    return nil
end

local function round(v, d)
    v = tonumber(v)
    if v == nil or v ~= v or v == math.huge or v == -math.huge then return nil end
    local m = 10 ^ (d or 0)
    return math.floor(v * m + 0.5) / m
end

-------------------------------------------------------------------------------
-- JSON encoding (robust against X4 text escapes and invalid UTF-8 from mods)

local ARR = {}
local function arr(t) return setmetatable(t or {}, ARR) end

local function utf8clean(s)
    if not sfind(s, "[\128-\255]") then return s end
    local out, i, n = {}, 1, #s
    while i <= n do
        local c = sbyte(s, i)
        local len = 0
        if c < 0x80 then len = 1
        elseif c >= 0xC2 and c <= 0xDF then len = 2
        elseif c >= 0xE0 and c <= 0xEF then len = 3
        elseif c >= 0xF0 and c <= 0xF4 then len = 4 end
        local ok = len > 0 and (i + len - 1) <= n
        if ok and len > 1 then
            for j = i + 1, i + len - 1 do
                local d = sbyte(s, j)
                if d < 0x80 or d > 0xBF then ok = false; break end
            end
            if ok and len == 3 then
                local d = sbyte(s, i + 1)
                if (c == 0xE0 and d < 0xA0) or (c == 0xED and d > 0x9F) then ok = false end
            elseif ok and len == 4 then
                local d = sbyte(s, i + 1)
                if (c == 0xF0 and d < 0x90) or (c == 0xF4 and d > 0x8F) then ok = false end
            end
        end
        if ok then
            out[#out + 1] = ssub(s, i, i + len - 1); i = i + len
        else
            out[#out + 1] = "?"; i = i + 1
        end
    end
    return tconcat(out)
end

local escapes = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
local function escchar(c) return escapes[c] or sfmt("\\u%04x", sbyte(c)) end

local function encstr(s)
    -- X4 text escapes: \27[icon], \27#AARRGGBB#, \27X / \27<char>
    if sfind(s, "\27", 1, true) then
        s = sgsub(s, "\27%b[]", "")
        s = sgsub(s, "\27#%x+#", "")
        s = sgsub(s, "\27.", "")
        s = sgsub(s, "\27", "")
    end
    s = utf8clean(s)
    s = sgsub(s, '[%c"\\]', escchar)
    return '"' .. s .. '"'
end

local enc
enc = function(v, buf)
    local t = type(v)
    if t == "string" then
        buf[#buf + 1] = encstr(v)
    elseif t == "number" then
        if v ~= v or v == math.huge or v == -math.huge then buf[#buf + 1] = "null"
        elseif v == math.floor(v) and v > -1e15 and v < 1e15 then buf[#buf + 1] = sfmt("%.0f", v)
        else buf[#buf + 1] = sfmt("%.4f", v) end
    elseif t == "boolean" then
        buf[#buf + 1] = v and "true" or "false"
    elseif t == "table" then
        if getmetatable(v) == ARR or v[1] ~= nil then
            buf[#buf + 1] = "["
            for i = 1, #v do
                if i > 1 then buf[#buf + 1] = "," end
                enc(v[i], buf)
            end
            buf[#buf + 1] = "]"
        else
            buf[#buf + 1] = "{"
            local first = true
            for k, val in pairs(v) do
                if val ~= nil then
                    if not first then buf[#buf + 1] = "," end
                    first = false
                    buf[#buf + 1] = encstr(tostring(k))
                    buf[#buf + 1] = ":"
                    enc(val, buf)
                end
            end
            buf[#buf + 1] = "}"
        end
    elseif t == "cdata" then
        local n = tonumber(v)
        if n then enc(n, buf) else buf[#buf + 1] = "null" end
    else
        buf[#buf + 1] = "null"
    end
end
local function json(v)
    local buf = {}
    enc(v, buf)
    return tconcat(buf)
end

-------------------------------------------------------------------------------
-- Pipe

local onRead   -- forward

local function getPipes()
    if W.pipes then return W.pipes end
    local now = realtime()
    if (now - W.pipes_tried) < 5 and now >= W.pipes_tried then return nil end
    W.pipes_tried = now
    local ok, P = pcall(require, "extensions.sn_mod_support_apis.ui.named_pipes.Pipes")
    if ok and type(P) == "table" and type(P.Schedule_Write) == "function" then
        W.pipes = P
        if P.winpipe_loaded == false then
            err("winpipe", "SN winpipe dll not loaded (Protected UI Mode on?) - pipe stays disconnected")
        end
        return P
    end
    err("require", "SN Pipes API not available: " .. tostring(P))
    return nil
end

local CH, CH_ORDER = {}, {}   -- forward-declared channel tables (filled below)

local function markAllResync()
    for _, ch in ipairs(CH_ORDER) do
        ch.resync = true
        ch.next_due = 0
        if ch.on_resync then pcall(ch.on_resync, ch) end
    end
end

local function onWriteDone(result)
    if W.pending > 0 then W.pending = W.pending - 1 end
    if result == "SUCCESS" then
        if not W.connected then
            W.connected = true
            info("conn", "pipe \\\\.\\pipe\\" .. CFG.pipe_name .. " connected")
            markAllResync()
            if not W.reading and W.pipes and type(W.pipes.Schedule_Read) == "function" then
                local ok = pcall(W.pipes.Schedule_Read, CFG.pipe_name, onRead, true)
                W.reading = ok
            end
        end
    else
        -- SN quirk (pipes.lua:814-840): a write that failed once and then succeeded on the
        -- retry is still reported as ERROR and the pipe gets closed. The message may have been
        -- delivered - the server copes with duplicates; we just reconnect and resend everything.
        W.nfail = W.nfail + 1
        if W.connected then
            info("conn", "pipe write failed (server stopped?) - retrying every " .. CFG.hello_every .. " s")
        end
        W.connected = false
    end
end

local function rawsend(msg)
    local P = getPipes()
    if not P then return false end
    W.pending = W.pending + 1
    W.busy_since = realtime()
    local ok, e = pcall(P.Schedule_Write, CFG.pipe_name, onWriteDone, msg)
    if not ok then
        W.pending = math.max(0, W.pending - 1)
        W.connected = false
        err("write", "Schedule_Write raised: " .. tostring(e))
        return false
    end
    W.nsent = W.nsent + 1
    W.nbytes = W.nbytes + #msg
    return true
end

local function canSend(droppable)
    if not W.connected and droppable ~= false then return false end
    if W.pending >= CFG.max_pending then
        if (realtime() - W.busy_since) > CFG.busy_reset then
            W.pending = 0
        elseif droppable ~= false then
            W.ndrop = W.ndrop + 1
            return false
        end
    end
    return true
end

-- send one message object (table). droppable messages are skipped while disconnected or
-- while too many writes are outstanding; the channel then resends on the next pass.
local function send(obj, droppable)
    if not canSend(droppable) then return false end
    obj.v = 2
    obj.src = W.src
    return rawsend(json(obj) .. "\n")
end

-- like send(), but splices an already encoded JSON array as obj.items
local function sendItems(obj, items_js, droppable)
    if not canSend(droppable) then return false end
    obj.v = 2
    obj.src = W.src
    local head = json(obj)
    return rawsend(ssub(head, 1, -2) .. ',"items":[' .. items_js .. ']}\n')
end

-- chunked list sender: encoded items accumulate until max_msg, then go out as one message
local function newChunker(mtype, extra)
    return { mtype = mtype, extra = extra or {}, items = {}, bytes = 0, part = 0, sent_ok = true, n = 0 }
end
local function chunkFlush(ck, last)
    local m = { type = ck.mtype, part = ck.part, last = last and true or false }
    for k, v in pairs(ck.extra) do m[k] = v end
    if not sendItems(m, tconcat(ck.items, ",")) then ck.sent_ok = false end
    ck.part = ck.part + 1
    ck.items = {}
    ck.bytes = 0
end
local function chunkAddJs(ck, js)
    if #js > CFG.max_msg - 1000 then return end          -- never exceed the pipe buffer
    if ck.bytes + #js > CFG.max_msg - 1000 and #ck.items > 0 then chunkFlush(ck, false) end
    ck.items[#ck.items + 1] = js
    ck.bytes = ck.bytes + #js + 1
    ck.n = ck.n + 1
end
local function chunkAdd(ck, item) chunkAddJs(ck, json(item)) end

-------------------------------------------------------------------------------
-- Channel framework

local function defchan(name, def)
    local ch = {
        name = name, base = def.every, interval = def.every, max_interval = def.max or def.every * 8,
        budget = def.budget or 0.06, steps_per_frame = def.steps or 4,
        start = def.start, step = def.step, on_resync = def.on_resync,
        next_due = def.delay or 0, job = nil, resync = true,
        disabled = false, errors = 0, runs = 0, last_err = nil,
        win_ms = 0, win_max = 0, pass_ms = 0, cur_pass = 0, last_pass_ms = 0, frame_ms = 0,
        win_ops = 0, frame_ops = 0, cur_ops = 0, last_pass_ops = 0,
        state = {},
    }
    CH[name] = ch
    CH_ORDER[#CH_ORDER + 1] = ch
    return ch
end

local function chError(ch, e)
    ch.errors = ch.errors + 1
    ch.last_err = tostring(e)
    ch.job = nil
    if ch.errors >= CFG.ch_err_limit then
        ch.disabled = true
        err("choff:" .. ch.name, "channel '" .. ch.name .. "' switched off after " .. ch.errors .. " errors: " .. ch.last_err)
    else
        warn("ch:" .. ch.name, "channel '" .. ch.name .. "' step failed: " .. ch.last_err)
    end
end

local rr = 1   -- round-robin start index

local function overBudget(t0, o0)
    if HIRES then return (hires() - t0) > CFG.frame_budget_ms end
    return (OPS - o0) > CFG.frame_budget_ops
end

local function schedule(now)
    local t0, o0 = hires(), OPS
    local nch = #CH_ORDER
    for k = 0, nch - 1 do
        local ch = CH_ORDER[((rr + k - 1) % nch) + 1]
        if not ch.disabled then
            if ch.job == nil and now >= ch.next_due and W.connected then
                local s0, p0 = hires(), OPS
                local ok, job = pcall(ch.start, ch, now)
                local dt, dops = hires() - s0, OPS - p0
                ch.frame_ms = ch.frame_ms + dt
                ch.frame_ops = ch.frame_ops + dops
                ch.cur_pass, ch.cur_ops = dt, dops
                if not ok then
                    chError(ch, job)
                    ch.next_due = now + ch.interval
                elseif job == nil or job == true then
                    ch.next_due = now + ch.interval   -- finished inside start()
                    ch.last_pass_ms, ch.last_pass_ops = ch.cur_pass, ch.cur_ops
                    ch.runs = ch.runs + 1
                    ch.resync = false
                else
                    ch.job = job
                end
            end
            local nsteps = 0
            while ch.job ~= nil and nsteps < ch.steps_per_frame do
                if nsteps > 0 and overBudget(t0, o0) then break end
                nsteps = nsteps + 1
                local s0, p0 = hires(), OPS
                local ok, done = pcall(ch.step, ch, ch.job, now)
                local dt, dops = hires() - s0, OPS - p0
                ch.frame_ms = ch.frame_ms + dt
                ch.frame_ops = ch.frame_ops + dops
                ch.cur_pass, ch.cur_ops = ch.cur_pass + dt, ch.cur_ops + dops
                if not ok then
                    chError(ch, done)
                    ch.next_due = now + ch.interval
                elseif done then
                    ch.job = nil
                    ch.next_due = now + ch.interval
                    ch.last_pass_ms, ch.last_pass_ops = ch.cur_pass, ch.cur_ops
                    ch.runs = ch.runs + 1
                    ch.resync = false
                end
            end
        end
        if overBudget(t0, o0) then
            rr = ((rr + k) % nch) + 1   -- next frame starts after the last channel that ran
            break
        end
    end
    local total = hires() - t0
    for _, ch in ipairs(CH_ORDER) do
        if ch.frame_ms > 0 or ch.frame_ops > 0 then
            ch.win_ms = ch.win_ms + ch.frame_ms
            ch.win_ops = ch.win_ops + ch.frame_ops
            if ch.frame_ms > ch.win_max then ch.win_max = ch.frame_ms end
            ch.frame_ms, ch.frame_ops = 0, 0
        end
    end
    W.frame_ms_sum = W.frame_ms_sum + total
    W.frame_ops_sum = (W.frame_ops_sum or 0) + (OPS - o0)
    W.frame_n = W.frame_n + 1
    if total > W.frame_ms_max then W.frame_ms_max = total end
end

-------------------------------------------------------------------------------
-- Common object readers

local function className(id)
    return cstr(S("c.class", C.GetComponentClass, id)) or "?"
end

local function knownName(id)
    local unlocked = S("c.unlock", C.IsInfoUnlockedForPlayer, id, "name")
    if unlocked == false then return "???" end
    return cstr(S("c.name", C.GetComponentName, id))
end

local function sectorOf(id)
    return to64(S("c.sector", C.GetContextByClass, id, "sector", false))
end

local function posOf(id)
    local p = S("c.pos", C.GetObjectPositionInSector, id)
    if p == nil then return nil end
    return round(p.x, 0), round(p.y, 0), round(p.z, 0), round(p.yaw, 4)
end

-- What the player has discovered - the bridge never sends anything the game's own map would
-- not show (decided here, not in the browser):
--   sector known:  GetClusters(true) + GetSectors (vanilla menu_map.lua:29492 "prepareKnownSectors")
--                  AND C.IsKnownToPlayer(sector) (same filter: menu_diplomacy.lua:1922, menu_encyclopedia.lua:833)
--   sector name:   only if C.IsInfoUnlockedForPlayer(sector, "name"), else "?" (menu_map.lua:14907; the game
--                  shows "Unknown sector" then, see helper.lua:13033-13036)
--   station/gate:  GetComponentData(obj, "isknown") and "isradarvisible" (map object filter, menu_map.lua:7553-7562)
--   ship/other:    CanViewLiveData(obj) - the live-data rule the map applies to its focus/selection
--                  (menu_map.lua:6210, 6232), fallback "isinliveview" (menu_interactmenu.lua:5686)
--   own objects:   always
local knownCache, knownAt = {}, -1e9
local function sectorKnown(sec, now)
    if sec == nil or sec == 0 then return false end
    now = now or realtime()
    if (now - knownAt) > 10 or now < knownAt then knownCache = {}; knownAt = now end
    local k = knownCache[sec]
    if k == nil then
        k = S("k.sector", C.IsKnownToPlayer, sec) and true or false
        knownCache[sec] = k
    end
    return k
end

local function liveVisible(o)
    local cvl = rawget(_G, "CanViewLiveData")
    if type(cvl) == "function" then
        local v = S("k.live", cvl, o)
        if v ~= nil then return v and true or false end
    end
    return S("k.inliveview", GetComponentData, o, "isinliveview") and true or false
end

local SHIP_CLASSES = { ship_xs = true, ship_s = true, ship_m = true, ship_l = true, ship_xl = true, spacesuit = true }

-- the one visibility rule (sector channel, details, guidance/order targets)
local function objVisible(o, cls, isplayer, known, radar)
    if isplayer then return true end
    if cls == "station" or cls == "gate" or cls == "highwayentrygate" then return (known == true) and (radar ~= false) end
    return (known ~= false) and (radar ~= false) and liveVisible(o)
end

-- radar range of an own object (m): GetComponentData(obj, "maxradarrange") - menu_map.lua:13761 (ships,
-- stations), :14944 (deployables: satellites, probes); cached per object for a minute
local rrCache = {}
local function radarRange(o, now)
    local c = rrCache[o]
    if c and (now - c.t) < 60 and now >= c.t then return c.v end
    local v = round(S("s.radar", GetComponentData, o, "maxradarrange"), 0)
    if v and v <= 0 then v = nil end
    rrCache[o] = { v = v, t = now }
    return v
end

-- the game's map icon of an object: GetComponentData(obj, "icon") - menu_map.lua:20051 (any selected
-- component; for a highway its entry gate's icon :20059), :7301 (object list rows)
-- Ships and stations get it in their class-specific GetComponentData call; for the other classes it
-- is asked separately and a class whose "icon" query fails is never asked again (the browser then
-- uses the map legend's icon for that class, menu_map.lua:1543-1637).
local iconBad = {}
local function iconOf(o, cls)
    if iconBad[cls] then return nil end
    OPS = OPS + 1
    local ok, ic = pcall(GetComponentData, o, "icon")
    if not ok then iconBad[cls] = true; return nil end
    if type(ic) == "string" and ic ~= "" then return ic end
    return nil
end

-------------------------------------------------------------------------------
-- Channel: player

local missionNames = {}   -- mission id -> name (filled by the missions channel)

defchan("player", { every = 0.25, max = 1.0, budget = 0.05, start = function(ch, now)
    local pid = to64(S("p.id", C.GetPlayerID))
    local m = { type = "player", t = now, nframe = W.n_frame, nmd = W.n_md }
    if pid == 0 then
        m.ingame = false
        send(m)
        return true
    end
    m.ingame = true
    m.paused = S("p.paused", C.IsGamePaused) and true or false
    m.name = cstr(S("p.name", C.GetPlayerName))
    m.faction = cstr(S("p.faction", C.GetPlayerFactionName, false))
    m.money = S("p.money", GetPlayerMoney)
    m.gametime = round(S("p.gametime", C.GetCurrentGameTime), 1)

    local sec = sectorOf(pid)
    if sec ~= 0 then m.sector = { id = idstr(sec), name = cstr(S("c.name", C.GetComponentName, sec)) } end
    -- v1.2 (M6): on a sector change the galaxy (owner, cluster, a just-discovered sector) and the new
    -- sector's scan go out at once instead of on their next interval (galaxy: up to 60 s later)
    if sec ~= 0 and sec ~= W.player_sector then
        if W.player_sector ~= nil then
            knownAt = -1e9                                  -- the sector may have been discovered just now
            if CH.galaxy then CH.galaxy.next_due = 0 end
            if CH.sector then CH.sector.next_due = 0 end
            W.sector_changes = (W.sector_changes or 0) + 1
        end
        W.player_sector = sec
        -- v1.2: resource areas of the new sector (sliced sampling, see channel "resources") and its real
        -- core size / centre / contested state from MD (md\x4_companion_sector.xml)
        if CH.resources then CH.resources.next_due = 0; CH.resources.want = true end
        W.sectorinfo_due = 0
        W.gates_due = 0                                  -- v1.2: gate list re-collected at once (MD), not in <= 60 s
    end
    if W.connected and W.sectorinfo_due and now >= W.sectorinfo_due then
        W.sectorinfo_due = nil
        S("si.request", AddUITriggeredEvent, "x4companion", "sectorinfo")
    end
    if W.connected and W.gates_due and now >= W.gates_due then
        W.gates_due = nil
        W.gates_requested = now
        S("g.request", AddUITriggeredEvent, "x4companion", "gates")
    end

    -- where is the player: the object we follow is the one the player is in
    local controlled = to64(S("p.controlled", C.GetPlayerControlledShipID))
    local ship = to64(S("p.ship", C.GetPlayerOccupiedShipID))
    local container = to64(S("p.container", C.GetContextByClass, pid, "container", false))
    local ref, mode = ship, "ship"
    if controlled ~= 0 then
        ref, ship, mode = controlled, controlled, "pilot"
    elseif ship ~= 0 then
        mode = "passenger"
    elseif container ~= 0 then
        ref = container
        mode = S("c.isstation", C.IsComponentClass, container, "station") and "station" or "aboard"
    else
        ref, mode = pid, "spacesuit"
    end
    local where = { mode = mode }
    if ref ~= pid then where.name = cstr(S("c.name", C.GetComponentName, ref)) end
    if ship ~= 0 and S("p.docked", GetComponentData, ship, "isdocked") then
        local at = to64(S("p.dockedat", C.GetContextByClass, ship, "container", false))
        if at ~= 0 and at ~= ship then
            where.docked = cstr(S("c.name", C.GetComponentName, at))
            where.dockedid = idstr(at)
        end
    end
    m.where = where
    local x, y, z, yaw = posOf(ref)
    local obj = { id = idstr(ref), mode = mode, x = x, y = y, z = z, yaw = yaw,
                  name = cstr(S("c.name", C.GetComponentName, ref)), class = className(ref) }
    if ship ~= 0 then
        local hull, shield, code = S("p.shipdata", GetComponentData, ship, "hullpercent", "shieldpercent", "idcode")
        obj.hull = round(hull, 1); obj.shield = round(shield, 1); obj.code = code
        local sp = S("p.maxspeed", C.GetDefensibleSpeeds, ship)
        if sp then obj.maxspeed = round(sp.speed, 0); obj.travelspeed = round(sp.travelspeed, 0) end
        local gps = rawget(_G, "GetPlayerSpeed")   -- core-env global (crosshair handling.lua:3358); may not exist here
        if type(gps) == "function" then
            local actual = S("p.speed", gps)
            obj.speed = round(actual, 1)
        end
    end
    if ship ~= 0 then
        local ic = S("p.icon", GetComponentData, ship, "icon")
        obj.ic = (type(ic) == "string" and ic ~= "") and ic or nil
        obj.rr = radarRange(ship, now)
    end
    m.object = obj

    -- plotted course (guidance) and autopilot target: GetActiveGuidanceMissionComponent()
    -- (menu_map.lua:29546, menu_interactmenu.lua:1129), GetAutoPilotTarget() (menu_map.lua:6734).
    -- Same visibility rule as everything else; position only when the target itself is visible.
    local function routeTarget(tag, fn)
        local t = to64(S(tag, fn))
        if t == 0 or not S("c.valid", IsValidComponent, t) then return nil end
        local tsec = S("c.issector", C.IsComponentClass, t, "sector") and t or sectorOf(t)
        if not sectorKnown(tsec, now) then return { unknown = true } end
        local r = { id = idstr(t), s = idstr(tsec) }
        local tcls = className(t)
        if tcls ~= "sector" then
            local isplayer, known, radar = S(tag .. ".d", GetComponentData, t, "isplayerowned", "isknown", "isradarvisible")
            if tcls == "zone" or objVisible(t, tcls, isplayer, known, radar) then
                local tx, _, tz = posOf(t)
                r.x, r.z = tx, tz
                if tcls ~= "zone" then r.n = knownName(t) end
            end
        end
        return r
    end
    m.guidance = routeTarget("p.guidance", GetActiveGuidanceMissionComponent)
    m.autopilot = routeTarget("p.autopilot", GetAutoPilotTarget)

    local st = S("p.target", C.GetSofttarget2)
    local tid = st and to64(st.softtargetID) or 0
    if tid ~= 0 and S("c.valid", IsValidComponent, tid) then
        local tx, ty, tz = posOf(tid)
        local hull, shield, owner, rel, enemy, hostile = S("p.targetdata", GetComponentData, tid, "hullpercent", "shieldpercent", "owner", "uirelation", "isenemy", "ishostile")
        m.target = { id = idstr(tid), name = knownName(tid), class = className(tid), hull = round(hull, 1),
                     shield = round(shield, 1), owner = owner, rel = rel, enemy = enemy, hostile = hostile,
                     dist = round(S("p.dist", C.GetDistanceBetween, ref, tid), 0), x = tx, z = tz,
                     sector = idstr(sectorOf(tid)) }
    end
    local am = to64(S("p.mission", C.GetActiveMissionID))
    if am ~= 0 then m.mission = { id = idstr(am), name = missionNames[idstr(am)] } end
    m.watch = W.watch ~= 0 and idstr(W.watch) or nil
    send(m)
    return true
end })

-------------------------------------------------------------------------------
-- Channel: galaxy (known clusters and sectors; static geometry from the live game)

local wareYieldBuf, wareYieldCap = nil, 0

defchan("galaxy", { every = 60, max = 300, budget = 0.04, steps = 2,
    start = function(ch, now)
        local clusters = S("g.clusters", GetClusters, true)
        if type(clusters) ~= "table" then return true end
        return { list = clusters, i = 1, out = {}, sig = {} }
    end,
    step = function(ch, job, now)
        local cl = job.list[job.i]
        if cl == nil then
            local sig = tconcat(job.sig, ";")
            if ch.resync or sig ~= ch.state.sig then
                ch.state.sig = sig
                ch.state.gen = (ch.state.gen or 0) + 1
                local ck = newChunker("galaxy", { gen = ch.state.gen })
                for _, c in ipairs(job.out) do chunkAdd(ck, c) end
                chunkFlush(ck, true)
                if not ck.sent_ok then ch.state.sig = nil end
            end
            -- gates follow the galaxy: request a fresh MD enumeration every minute or on resync (v1.2; also on a sector change and on a gate discovery)
            if ch.resync or (now - W.gates_requested) > 60 then
                W.gates_requested = now
                S("g.request", AddUITriggeredEvent, "x4companion", "gates")
                if W.gates_state ~= "received" then W.gates_state = "requested" end
            end
            return true
        end
        job.i = job.i + 1
        local c64 = to64(cl)
        local name, macro = S("g.cdata", GetComponentData, c64, "name", "macro")
        if S("k.cname", C.IsInfoUnlockedForPlayer, c64, "name") == false then name = "?" end
        local off = S("g.offset", C.GetPositionalOffset, c64, 0)
        local centry = { id = idstr(c64), name = name, macro = macro,
                         x = off and round(off.x, 0), z = off and round(off.z, 0), sectors = arr() }
        local sectors = S("g.sectors", GetSectors, cl) or {}
        for _, s in ipairs(sectors) do
            local s64 = to64(s)
            if sectorKnown(s64, now) then
            local sname, smacro, owner = S("g.sdata", GetComponentData, s64, "name", "macro", "owner")
            if S("k.name", C.IsInfoUnlockedForPlayer, s64, "name") == false then sname, owner = "?", nil end
            local soff = S("g.offset", C.GetPositionalOffset, s64, 0)
            local se = { id = idstr(s64), name = sname, macro = smacro, owner = owner,
                         x = soff and round(soff.x, 0), z = soff and round(soff.z, 0) }
            local nres = tonumber(S("g.nres", C.GetNumDiscoveredSectorResources, s64)) or 0
            if nres > 0 then
                if nres > wareYieldCap then wareYieldBuf = ffi.new("WareYield[?]", nres); wareYieldCap = nres end
                local n = tonumber(S("g.res", C.GetDiscoveredSectorResources, wareYieldBuf, nres, s64)) or 0
                local res = arr()
                for r = 0, n - 1 do
                    res[#res + 1] = { w = cstr(wareYieldBuf[r].ware), c = wareYieldBuf[r].current, m = wareYieldBuf[r].max }
                end
                se.res = res
            end
            centry.sectors[#centry.sectors + 1] = se
            job.sig[#job.sig + 1] = tostring(se.id) .. ":" .. tostring(owner) .. ":" .. tostring(sname)
            end
        end
        if #centry.sectors > 0 then job.out[#job.out + 1] = centry end
        return false
    end })

-------------------------------------------------------------------------------
-- Gates: MD raises x4companion.gatesBegin / .gate (param = gate) / .gatesEnd

-- v1.1: MD stores the lists on the player's blackboard and raises ONE event (see md\x4_companion_gates.xml;
-- one raise_lua_event per gate delivered a single gate in the real game). Read + clear like SirNukes'
-- APIs do: GetNPCBlackboard(player, "$var") / SetNPCBlackboard(player, "$var", nil)
-- (vanilla GetNPCBlackboard menu_map.lua:4137, SetNPCBlackboard menu_trader_inventory.lua:538).
local function readBlackboardList(pid, var, out, sign)
    local list = S("g.bb", GetNPCBlackboard, pid, var)
    S("g.bbclear", SetNPCBlackboard, pid, var, nil)
    local n = 0
    if type(list) == "table" then
        for _, gate in ipairs(list) do
            local g = to64(gate)
            if g ~= 0 and #out < 5000 then out[#out + 1] = sign * g; n = n + 1 end
        end
    end
    return n
end
local function onGates(_, mdcount)
    local pid = S("g.pid", ConvertStringTo64Bit, tostring(C.GetPlayerID()))
    if not pid then return end
    local out = {}
    local n = readBlackboardList(pid, "$x4companion_gates", out, 1)
    local nh = readBlackboardList(pid, "$x4companion_hwgates", out, -1)   -- negative = superhighway
    if n == 0 and nh == 0 then
        -- a second event of the same frame finds the lists already read: keep what we have
        W.gates_md = tonumber(mdcount) or W.gates_md
        return
    end
    W.gates = out
    W.gates_md = tonumber(mdcount)
    W.gates_rx = n
    W.gates_hw = nh
    W.gates_state = "received"
    if CH.gates then CH.gates.next_due = 0; CH.gates.fresh = true end
end

defchan("gates", { every = 5, max = 60, budget = 0.04, steps = 2,
    start = function(ch, now)
        if not ch.fresh and not ch.resync then return true end
        if #W.gates == 0 then return true end
        ch.fresh = false
        return { i = 1, ck = newChunker("gates", { n = #W.gates }) }
    end,
    step = function(ch, job, now)
        for _ = 1, 10 do
            local g = W.gates[job.i]
            if g == nil then
                chunkFlush(job.ck, true)
                W.gates_n = #W.gates
                if not job.ck.sent_ok then ch.fresh = true end
                return true
            end
            job.i = job.i + 1
            local hw = g < 0
            if hw then g = -g end
            if S("c.valid", IsValidComponent, g) then
                local sec = sectorOf(g)
                local isknown, radar = S("gt.known", GetComponentData, g, "isknown", "isradarvisible")
                -- v1.2: a known gate is shown whether or not it is in radar range right now (the game map draws
                -- known gates natively; isradarvisible only matters for the object list, menu_map.lua:7563)
                if sectorKnown(sec, now) and isknown ~= false then
                    local dest, isactive = S("gt.data", GetComponentData, g, "destination", "isactive")
                    local d64 = to64(dest)
                    local ds = d64 ~= 0 and sectorOf(d64) or 0
                    local x, y, z = posOf(g)
                    local e = { id = idstr(g), s = idstr(sec), a = isactive, x = x, z = z, hw = hw or nil }
                    -- destination only if that sector is known too; otherwise the game shows "?"
                    if ds ~= 0 and sectorKnown(ds, now) then e.ds = idstr(ds) elseif not hw or d64 ~= 0 then e.du = true end
                    chunkAdd(job.ck, e)
                end
            end
        end
        return false
    end })

-------------------------------------------------------------------------------
-- v1.2: sector info (MD -> blackboard -> Lua, md\x4_companion_sector.xml) and resource areas

-- Transport: the server forwards only the message types it knows, so both ride along with the player's
-- sector scan as two pseudo object classes (x4c_sectorinfo, x4c_resarea) - right after they change and
-- on every 10th scan (new browser tabs / reconnects); the browser takes them out of the object list.
local function sendSectorInfo(sid) W.si_fresh = true end
W.highways = {}

-- v1.2 local highways of the player's sector: MD hands over [highway, entry gate] per lane; each lane's
-- spline nodes (offset, tangent, in/out length) become a cubic Bezier sampled 10x per segment. The
-- offsets are taken in sector coordinates if the first or last node lies at the entry gate, else
-- relative to the highway zone's position (whichever matches the entry gate).
local function readHighways(pid)
    local list = S("hw.bb", GetNPCBlackboard, pid, "$x4companion_highways")
    S("hw.bbclear", SetNPCBlackboard, pid, "$x4companion_highways", nil)
    local out = {}
    if type(list) ~= "table" then return out end
    for _, lane in ipairs(list) do
        local hw = type(lane) == "table" and to64(lane[1]) or 0
        local entry = type(lane) == "table" and to64(lane[2]) or 0
        local n = hw ~= 0 and (tonumber(S("hw.num", C.GetNumHighwaySplinePoints, hw)) or 0) or 0
        if n >= 2 and n <= 200 then
            local buf = ffi.new("SplineData[?]", n)
            n = tonumber(S("hw.get", C.GetHighwaySplinePoints, buf, n, hw)) or 0
            if n >= 2 then
                local zx, _, zz = posOf(hw)
                local ex, _, ez = posOf(entry)
                local ox, oz = 0, 0
                if zx and ex then
                    local function d(px, pz) return math.min((buf[0].offset.x + px - ex) ^ 2 + (buf[0].offset.z + pz - ez) ^ 2,
                        (buf[n - 1].offset.x + px - ex) ^ 2 + (buf[n - 1].offset.z + pz - ez) ^ 2) end
                    if d(zx, zz) < d(0, 0) then ox, oz = zx, zz end
                end
                local pts = arr()
                for i = 0, n - 2 do
                    local a, b = buf[i], buf[i + 1]
                    local p0x, p0z = a.offset.x + ox, a.offset.z + oz
                    local p3x, p3z = b.offset.x + ox, b.offset.z + oz
                    local p1x, p1z = p0x + a.tangent.x * a.outlength, p0z + a.tangent.z * a.outlength
                    local p2x, p2z = p3x - b.tangent.x * b.inlength, p3z - b.tangent.z * b.inlength
                    for k = (i == 0) and 0 or 1, 10 do
                        local t = k / 10
                        local u = 1 - t
                        local x = u * u * u * p0x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3x
                        local z = u * u * u * p0z + 3 * u * u * t * p1z + 3 * u * t * t * p2z + t * t * t * p3z
                        pts[#pts + 1] = round(x / 1000, 2); pts[#pts + 1] = round(z / 1000, 2)
                    end
                end
                out[#out + 1] = pts
            end
        end
    end
    return out
end
local function onSectorInfo(_, param)
    local pid = S("si.pid", ConvertStringTo64Bit, tostring(C.GetPlayerID()))
    if not pid then return end
    local list = S("si.bb", GetNPCBlackboard, pid, "$x4companion_sectorinfo")
    S("si.bbclear", SetNPCBlackboard, pid, "$x4companion_sectorinfo", nil)
    if type(list) ~= "table" or list[1] == nil then return end   -- a duplicate event of the same frame
    local sec = to64(list[1])
    if sec == 0 or not sectorKnown(sec) then return end
    local sid = idstr(sec)
    local core = tonumber(list[2])
    W.highways[sid] = readHighways(pid)
    W.si_fresh_hw = true
    W.sectorinfo[sid] = { core = (core and core > 0) and round(core, 0) or nil,
                          cx = round(tonumber(list[3]) or 0, 0), cz = round(tonumber(list[4]) or 0, 0),
                          contested = (list[5] == true or list[5] == 1) }
    sendSectorInfo(sid)
    if CH.resources and not CH.resources.job then CH.resources.want = true; CH.resources.next_due = 0 end
end

-- Resource areas of the player's sector, like the game map's mining layer (the holomap draws its
-- patches natively: SetMapRenderResourceInfo, menu_map.lua:5824). Sampled on a hex grid with
-- GetMineablesAtSectorPos (menu_interactmenu.lua:5890-5892 "mine here"), reported only for the wares the
-- player has discovered in that sector (GetDiscoveredSectorResources = the game's discovery rule).
-- Cost: only after a sector change / reconnect / every 10 min, sliced over frames (RES_PER_STEP samples
-- = 2 engine calls each per step), the result cached for resends.
local RES_CELL, RES_RADIUS, RES_MAX_RADIUS, RES_PER_STEP, RES_REFRESH = 10000, 250000, 500000, 24, 600
local resYield, resYieldCap, resPos = nil, 0, nil
local function sendResources(st) W.res = st; W.res_fresh = true end
-- the pseudo objects for the scan of sector sid (at most 1200 cells per object: one pipe message holds it)
local function sectorExtras(sid, n)
    local out = {}
    local si = W.sectorinfo[sid]
    if si and (W.si_fresh or n % 10 == 0) then
        out[#out + 1] = { id = "si:" .. sid, c = "x4c_sectorinfo", core = si.core, cx = si.cx, cz = si.cz, contested = si.contested }
        W.si_fresh = false
    end
    local hws = W.highways[sid]
    if hws and (W.si_fresh_hw or n % 10 == 0) then
        for k, pts in ipairs(hws) do out[#out + 1] = { id = "hw:" .. sid .. ":" .. k, c = "x4c_highway", pts = pts } end
        W.si_fresh_hw = false
    end
    local st = W.res
    if st and st.sid == sid and (W.res_fresh or n % 10 == 0) then
        local per = {}
        for _, it in ipairs(st.items) do
            local w = st.wares[it[3] + 1]
            per[w] = per[w] or {}
            local p = per[w]
            p[#p + 1] = it[1]; p[#p + 1] = it[2]; p[#p + 1] = it[4]
        end
        local k = 0
        for _, w in ipairs(st.wares) do
            local p = per[w] or {}
            for i = 1, math.max(1, #p), 3600 do
                k = k + 1
                local part = arr()
                for j = i, math.min(#p, i + 3599) do part[#part + 1] = p[j] end
                out[#out + 1] = { id = "res:" .. sid .. ":" .. k, c = "x4c_resarea", w = w, cell = RES_CELL, gen = st.gen, pts = part }
            end
        end
        if #st.wares == 0 then out[#out + 1] = { id = "res:" .. sid .. ":0", c = "x4c_resarea", cell = RES_CELL, gen = st.gen, pts = arr() } end
        W.res_fresh = false
    end
    return out
end
defchan("resources", { every = 2, max = 20, budget = 0.06, steps = 3, delay = 4,
    start = function(ch, now)
        local pid = to64(S("p.id", C.GetPlayerID))
        local sec = (pid ~= 0) and sectorOf(pid) or 0
        if sec == 0 then return true end
        local sid = idstr(sec)
        local st = ch.state
        if st.sid == sid and st.items and not ch.want then
            if ch.resync then sendResources(st); sendSectorInfo(sid); return true end
            if (now - (st.at or 0)) < RES_REFRESH then return true end
        end
        ch.want = false
        local nres = tonumber(S("r.nres", C.GetNumDiscoveredSectorResources, sec)) or 0
        local disc, any = {}, false
        if nres > 0 then
            local wb = ffi.new("WareYield[?]", nres)
            local n = tonumber(S("r.disc", C.GetDiscoveredSectorResources, wb, nres, sec)) or 0
            for i = 0, n - 1 do local w = cstr(wb[i].ware); if w then disc[w] = true; any = true end end
        end
        ch.state.gen = (ch.state.gen or 0) + 1
        if not any then
            ch.state = { sid = sid, wares = {}, items = {}, at = now, gen = ch.state.gen }
            sendResources(ch.state)
            return true
        end
        local si = W.sectorinfo[sid]
        local radius = (si and si.core) and math.min(RES_MAX_RADIUS, si.core / 2 * 1.15) or RES_RADIUS
        local h = RES_CELL * 0.8660254
        local J, I = math.ceil(radius / h), math.ceil(radius / RES_CELL) + 1
        if resPos == nil then resPos = ffi.new("Coord3D") end
        return { sec = sec, sid = sid, disc = disc, cx = si and si.cx or 0, cz = si and si.cz or 0, radius = radius,
                 h = h, J = J, I = I, j = -J, i = -I, wares = {}, wi = {}, items = {}, gen = ch.state.gen }
    end,
    step = function(ch, job, now)
        if ch.want then return true end           -- the player moved on: start over for the new sector
        local done, r2 = 0, job.radius * job.radius
        while done < RES_PER_STEP do
            if job.j > job.J then
                ch.state = { sid = job.sid, wares = job.wares, items = job.items, at = now, gen = job.gen }
                sendResources(ch.state)
                return true
            end
            local x = job.i * RES_CELL + ((job.j % 2 ~= 0) and RES_CELL / 2 or 0)
            local z = job.j * job.h
            job.i = job.i + 1
            if job.i > job.I then job.i = -job.I; job.j = job.j + 1 end
            if x * x + z * z <= r2 then
                done = done + 1
                resPos.x, resPos.y, resPos.z = job.cx + x, 0, job.cz + z
                local num = tonumber(S("r.num", C.GetNumMineablesAtSectorPos, job.sec, resPos)) or 0
                if num > 0 then
                    if num > resYieldCap then resYield = ffi.new("YieldInfo[?]", num); resYieldCap = num end
                    local got = tonumber(S("r.get", C.GetMineablesAtSectorPos, resYield, num, job.sec, resPos)) or 0
                    for k = 0, got - 1 do
                        local w = cstr(resYield[k].wareid)
                        local a = tonumber(resYield[k].amount) or 0
                        if w and a > 0 and job.disc[w] then
                            local wi = job.wi[w]
                            if not wi then wi = #job.wares + 1; job.wares[wi] = w; job.wi[w] = wi end
                            job.items[#job.items + 1] = arr({ round((job.cx + x) / 1000, 1), round((job.cz + z) / 1000, 1), wi - 1, a })
                        end
                    end
                end
            end
        end
        return false
    end })

-------------------------------------------------------------------------------
-- Channel: theme (the game map's own colours, sent on connect and when they change)
-- GetHoloMapColors(): helper.lua:13069-13071 (Helper.getHoloMapColors) - the colours the map legend
-- uses per relation/type (menu_map.lua:1543-1637: playercolor = owned, friendcolor = neutral,
-- enemycolor, hostilecolor, gatecolor, highwaygatecolor, ...). Color["..."] mappings of the UI
-- (libraries\colors.xml) for text/background: global Color table as used in menu_map.lua:7317.

local HOLO_NAMES = { "productioncolor", "buildcolor", "storagecolor", "radarcolor", "dronedockcolor", "efficiencycolor",
    "defencecolor", "playercolor", "friendcolor", "enemycolor", "missioncolor", "currentplayershipcolor", "visitorcolor",
    "lowalertcolor", "mediumalertcolor", "highalertcolor", "gatecolor", "highwaygatecolor", "missilecolor",
    "superhighwaycolor", "highwaycolor", "hostilecolor" }
local UI_COLORS = { "text_normal", "text_inactive", "text_player", "text_enemy", "text_hostile", "text_mission",
    "icon_normal", "row_background_selected", "table_row_highlight", "frame_background_semitransparent",
    "shieldhullbar_shield", "shieldhullbar_hull", "resource_map_default" }

local function colorOf(c)
    if type(c) ~= "table" then return nil end
    local r, g, b, a = tonumber(c.r), tonumber(c.g), tonumber(c.b), tonumber(c.a)
    if not (r and g and b) then return nil end
    return { r = round(r, 0), g = round(g, 0), b = round(b, 0), a = a and round(a, 0) or nil }
end

defchan("theme", { every = 30, max = 120, budget = 0.05,
    start = function(ch, now)
        local m = { type = "theme", holo = {}, ui = {} }
        local vals = { S("th.holo", GetHoloMapColors) }
        for i, name in ipairs(HOLO_NAMES) do m.holo[name] = colorOf(vals[i]) end
        local Col = rawget(_G, "Color")
        if type(Col) == "table" then
            for _, name in ipairs(UI_COLORS) do
                local ok, c = pcall(function() return Col[name] end)
                if ok then m.ui[name] = colorOf(c) end
            end
        end
        local js = json(m)
        if ch.resync or js ~= ch.state.last then
            if send(m) then ch.state.last = js end
        end
        return true
    end })

-------------------------------------------------------------------------------
-- Channel: sector (objects the player can see in the player's sector + one watched sector)

local factionIds, factionIdsAt = nil, -1e9
local function getFactionIds(now)
    if factionIds and (now - factionIdsAt) < 60 then return factionIds end
    local lib = S("f.lib", GetLibrary, "factions")
    local ids, seen = {}, {}
    if type(lib) == "table" then
        for _, f in ipairs(lib) do
            if type(f) == "table" and type(f.id) == "string" and not seen[f.id] then
                ids[#ids + 1] = f.id; seen[f.id] = true
            end
        end
    end
    for _, extra in ipairs({ "player", "ownerless" }) do
        if not seen[extra] then ids[#ids + 1] = extra; seen[extra] = true end
    end
    factionIds, factionIdsAt = ids, now
    return ids
end

local SECTOR_KEEP = {
    ship_xs = true, ship_s = true, ship_m = true, ship_l = true, ship_xl = true,
    station = true, gate = true, highwayentrygate = true, satellite = true, navbeacon = true,
    resourceprobe = true, lockbox = true, collectablewares = true, collectableammo = true,
    collectableblueprints = true, collectableshieldrestore = true, drop = true, mine = true,
    lasertower = true, buildstorage = true, crate = true, datavault = true, spacesuit = true,
}

defchan("sector", { every = 1.0, max = 8.0, budget = 0.12, steps = 6,
    start = function(ch, now)
        local pid = to64(S("p.id", C.GetPlayerID))
        if pid == 0 then return true end
        local targets = {}
        local psec = sectorOf(pid)
        if psec ~= 0 then targets[#targets + 1] = psec end
        ch.state.n = (ch.state.n or 0) + 1
        -- the watched sector is refreshed every second pass (half rate)
        if W.watch ~= 0 and W.watch ~= psec and (ch.state.n % 2 == 0 or ch.resync) and sectorKnown(W.watch, now) then targets[#targets + 1] = W.watch end
        if #targets == 0 then return true end
        return { targets = targets, ti = 0, phase = "next", now = now }
    end,
    step = function(ch, job, now)
        if job.phase == "next" then
            job.ti = job.ti + 1
            local sec = job.targets[job.ti]
            if sec == nil then return true end
            ch.state.gen = (ch.state.gen or 0) + 1
            job.sec = sec
            job.seclid = S("s.luaid", luaid, sec)
            job.factions = getFactionIds(now)
            job.fi = 1
            job.ids, job.seen = {}, {}
            job.oi = 1
            job.hidden, job.skipped = 0, 0
            job.ck = newChunker("sector", { sid = idstr(sec), gen = ch.state.gen,
                                            player = (job.ti == 1) and true or false })
            job.phase = "owners"
            return false
        elseif job.phase == "owners" then
            -- one faction per step: GetContainedObjectsByOwner(faction, sector) (v0: works in 9.00)
            local f = job.factions[job.fi]
            if f == nil or job.seclid == nil then job.phase = "objects"; return false end
            job.fi = job.fi + 1
            local list = S("s.owner", GetContainedObjectsByOwner, f, job.seclid)
            if type(list) == "table" then
                for _, o in ipairs(list) do
                    if #job.ids >= CFG.sector_max then break end
                    local o64 = to64(o)
                    if o64 ~= 0 and not job.seen[o64] then
                        job.seen[o64] = true
                        job.ids[#job.ids + 1] = o64
                    end
                end
            end
            return false
        else
            for _ = 1, 8 do
                local o = job.ids[job.oi]
                if o == nil then
                    if job.ti == 1 then for _, e in ipairs(sectorExtras(idstr(job.sec), ch.state.n or 0)) do chunkAdd(job.ck, e) end end
                    job.ck.extra.n = #job.ids
                    job.ck.extra.hidden = job.hidden
                    job.ck.extra.skipped = job.skipped
                    job.ck.extra.full = #job.ids >= CFG.sector_max
                    chunkFlush(job.ck, true)
                    job.phase = "next"
                    return false
                end
                job.oi = job.oi + 1
                local cls = className(o)
                if SECTOR_KEEP[cls] and S("c.valid", IsValidComponent, o) then
                    local owner, rel, isplayer, enemy, hostile, known, radar, wreck, purpose =
                        S("s.data", GetComponentData, o, "owner", "uirelation", "isplayerowned", "isenemy", "ishostile", "isknown", "isradarvisible", "iswreck", "primarypurpose")
                    if objVisible(o, cls, isplayer, known, radar) then
                        local x, y, z, yaw = posOf(o)
                        local e = { id = idstr(o), c = cls, n = knownName(o), o = owner, r = rel,
                                    x = x, y = y, z = z }
                        if isplayer then
                            e.pl = true
                            e.rr = radarRange(o, now)
                        end
                        if hostile then e.h = true elseif enemy then e.e = true end
                        if wreck then e.wr = true end
                        if SHIP_CLASSES[cls] then
                            e.yaw = yaw
                            e.p = purpose
                            -- icon + ismissiontarget as the object list asks them (menu_map.lua:7301)
                            local hull, code, ic, mt = S("s.ship", GetComponentData, o, "hullpercent", "idcode", "icon", "ismissiontarget")
                            e.hull = round(hull, 0); e.code = code; e.ic = ic; e.mt = mt or nil
                        elseif cls == "gate" or cls == "highwayentrygate" then
                            local dest = to64(S("s.gate", GetComponentData, o, "destination"))
                            local ds = dest ~= 0 and sectorOf(dest) or 0
                            if ds ~= 0 and sectorKnown(ds, now) then e.ds = idstr(ds) else e.du = true end
                            e.ic = iconOf(o, cls)
                        elseif cls == "station" then
                            local code, ic, mt, hull = S("s.code", GetComponentData, o, "idcode", "icon", "ismissiontarget", "hullpercent")
                            e.code = code; e.ic = ic; e.mt = mt or nil; e.hull = round(hull, 0)
                        else
                            e.ic = iconOf(o, cls)
                        end
                        if e.ic == "" then e.ic = nil end
                        chunkAdd(job.ck, e)
                    else
                        job.hidden = job.hidden + 1
                    end
                else
                    job.skipped = job.skipped + 1
                end
            end
            return false
        end
    end })

-------------------------------------------------------------------------------
-- Channel: property (all player ships and stations, diffed)

local orderBuf = nil
local orderNames = {}
local function orderName(def)
    if def == nil or def == "" then return nil end
    local n = orderNames[def]
    if n ~= nil then return n end
    local od = ffi.new("OrderDefinition")
    if S("o.def", C.GetOrderDefinition, od, def) then n = cstr(od.name) or def else n = def end
    orderNames[def] = n
    return n
end

local function currentOrder(id)
    local n = tonumber(S("o.num", C.GetNumOrders, id)) or 0
    if n > 0 then
        if orderBuf == nil then orderBuf = ffi.new("Order[64]") end
        n = tonumber(S("o.get", C.GetOrders, orderBuf, math.min(n, 64), id)) or 0
        if n > 0 then
            local cur = tonumber(S("o.cur", C.GetOrderQueueCurrentIdx, id)) or 1
            if cur < 1 or cur > n then cur = 1 end
            local o = orderBuf[cur - 1]
            local def = cstr(o.orderdef)
            return def, orderName(def), cstr(o.statename), n
        end
    end
    local d = ffi.new("Order")
    if S("o.default", C.GetDefaultOrder, d, id) then
        local def = cstr(d.orderdef)
        return def, orderName(def), cstr(d.statename), 0, true
    end
    return nil
end

-- Order queue of an own ship with the first map point of every order - the data behind the order
-- lines the game map draws for a selected ship. Queue: C.GetNumOrders / C.GetOrders (menu_map.lua:715/747),
-- parameters: GetOrderParams(ship, idx) (menu_map.lua:11376), a "position" parameter is
-- { space, { x, y, z } } (menu_map.lua:26781), an "object" parameter a component.
-- Points are only sent when their sector is known and (for objects) the object is visible.
local function paramPoint(p, now)
    if type(p) ~= "table" then return nil end
    local v = p.value
    if p.type == "position" and type(v) == "table" and type(v[2]) == "table" then
        local sp = to64(v[1])
        if sp == 0 then return nil end
        local issec = S("c.issector", C.IsComponentClass, sp, "sector")
        local sec = issec and sp or sectorOf(sp)
        if not sectorKnown(sec, now) then return nil end
        local bx, bz = 0, 0
        if not issec then local x, _, z = posOf(sp); bx, bz = x or 0, z or 0 end
        return { s = idstr(sec), x = round(bx + (tonumber(v[2][1]) or 0), 0), z = round(bz + (tonumber(v[2][3]) or 0), 0) }
    elseif p.type == "object" and v ~= nil and v ~= 0 then
        local o = to64(v)
        if o == 0 or not S("c.valid", IsValidComponent, o) then return nil end
        local sec = sectorOf(o)
        if not sectorKnown(sec, now) then return nil end
        local ocls = className(o)
        local isplayer, known, radar = S("o.pdata", GetComponentData, o, "isplayerowned", "isknown", "isradarvisible")
        if not objVisible(o, ocls, isplayer, known, radar) then return nil end
        local x, _, z = posOf(o)
        return { s = idstr(sec), x = x, z = z, id = idstr(o) }
    end
    return nil
end

local function orderQueue(ship)
    local now = realtime()
    local n = math.min(tonumber(S("o.num", C.GetNumOrders, ship)) or 0, 12)
    local out = arr()
    if n <= 0 then return out end
    local buf = ffi.new("Order[?]", n)
    n = tonumber(S("o.get", C.GetOrders, buf, n, ship)) or 0
    for i = 1, n do
        local def = cstr(buf[i - 1].orderdef)
        local e = { d = def, n = orderName(def), st = cstr(buf[i - 1].statename) }
        local params = S("o.params", GetOrderParams, ship, i)
        if type(params) == "table" then
            for _, p in ipairs(params) do
                local pt = paramPoint(p, now)
                if pt then e.pt = pt; break end
            end
        end
        out[#out + 1] = e
    end
    return out
end

local function enumIds(numfn, listfn, arg, tag)
    local n = tonumber(S(tag .. ".n", numfn, arg)) or 0
    local out = {}
    if n <= 0 then return out end
    local buf = ffi.new("UniverseID[?]", n)
    n = tonumber(S(tag .. ".l", listfn, buf, n, arg)) or 0
    for i = 0, n - 1 do out[#out + 1] = tonumber(buf[i]) end
    return out
end

defchan("property", { every = 4, max = 30, budget = 0.12, steps = 4,
    on_resync = function(ch) ch.state.sent = {} end,
    start = function(ch, now)
        local ships = enumIds(C.GetNumAllFactionShips, C.GetAllFactionShips, "player", "pr.ships")
        local stations = enumIds(C.GetNumAllFactionStations, C.GetAllFactionStations, "player", "pr.stations")
        while #ships + #stations > CFG.property_max and #ships > 0 do ships[#ships] = nil end
        ch.state.gen = (ch.state.gen or 0) + 1
        ch.state.sent = ch.state.sent or {}
        return { ships = ships, stations = stations, i = 1, j = 1, all = {},
                 ck = newChunker("property", { gen = ch.state.gen }), newsig = {} }
    end,
    step = function(ch, job, now)
        local sent = ch.state.sent
        for _ = 1, 6 do
            local id, kind = job.ships[job.i], "ship"
            if id then job.i = job.i + 1
            else
                id, kind = job.stations[job.j], "station"
                if id then job.j = job.j + 1 end
            end
            if id == nil then
                if job.ck.n > 0 and #job.ck.items > 0 then chunkFlush(job.ck, false) end
                local ok = send({ type = "property_end", gen = ch.state.gen, ids = arr(job.all),
                                  ships = #job.ships, stations = #job.stations })
                if job.ck.sent_ok and ok then
                    ch.state.sent = job.newsig
                else
                    ch.state.sent = {}   -- something was dropped: resend everything next pass
                end
                return true
            end
            local sid = idstr(id)
            job.all[#job.all + 1] = sid
            local e
            if kind == "ship" then
                local name, code, hull, shield, purpose, fleet, docked, macro, icon =
                    S("pr.ship", GetComponentData, id, "name", "idcode", "hullpercent", "shieldpercent", "primarypurpose", "fleetname", "isdocked", "macro", "icon")
                local def, oname, ostate, nord, isdef = currentOrder(id)
                local cmd = to64(S("pr.cmd", GetCommander, id))
                e = { id = sid, k = "ship", n = name, code = code, c = className(id), p = purpose,
                      s = idstr(sectorOf(id)), hull = round(hull, 0), shield = round(shield, 0),
                      fl = fleet ~= "" and fleet or nil, dk = docked or nil, mc = macro, ic = icon ~= "" and icon or nil,
                      od = def, on = oname, os = ostate, oq = nord, odf = isdef or nil,
                      cmd = cmd ~= 0 and idstr(cmd) or nil }
            else
                local name, code, hull, money, icon = S("pr.station", GetComponentData, id, "name", "idcode", "hullpercent", "money", "icon")
                local mods = tonumber(S("pr.modules", C.GetNumStationModules, id, false, false))
                local wf = S("pr.workforce", C.GetWorkForceInfo, id, "")
                e = { id = sid, k = "station", n = name, code = code, c = "station", s = idstr(sectorOf(id)), ic = icon ~= "" and icon or nil,
                      hull = round(hull, 0), money = round(money, 0), mods = mods,
                      wf = wf and tonumber(wf.current) or nil, wfc = wf and tonumber(wf.capacity) or nil }
            end
            local js = json(e)
            job.newsig[sid] = js
            if sent[sid] ~= js then chunkAddJs(job.ck, js) end
        end
        return false
    end })

-------------------------------------------------------------------------------
-- Channel: logbook (incremental per category)

local LOG_CATS = { "general", "missions", "news", "diplomacy", "alerts", "upkeep", "tips" }

local function logKey(e)
    return sfmt("%.3f|%s|%s", tonumber(e.time) or 0, tostring(e.title), tostring(e.text))
end

defchan("logbook", { every = 2, max = 15, budget = 0.06, steps = 2,
    on_resync = function(ch) ch.state.cats = {} end,
    start = function(ch, now)
        ch.state.cats = ch.state.cats or {}
        return { ci = 1 }
    end,
    step = function(ch, job, now)
        local cat = LOG_CATS[job.ci]
        if cat == nil then return true end
        job.ci = job.ci + 1
        local st = ch.state.cats[cat]
        if st == nil then st = { n = nil, key = nil, recent = {}, order = {} }; ch.state.cats[cat] = st end
        local n = tonumber(S("l.num", GetNumLogbook, cat)) or 0
        if n <= 0 then st.n = 0; return false end
        local newest = S("l.get", GetLogbook, n, 1, cat)
        local key = (type(newest) == "table" and newest[1]) and logKey(newest[1]) or nil
        local fetch = 0
        if st.n == nil then fetch = math.min(n, CFG.log_initial)
        elseif key ~= st.key or n > st.n then fetch = math.min(math.max(n - st.n, 1) + 2, 50, n) end
        st.n, st.key = n, key
        if fetch <= 0 then return false end
        local list = S("l.get", GetLogbook, n - fetch + 1, fetch, cat)
        if type(list) ~= "table" then return false end
        local items = arr()
        for _, e in ipairs(list) do
            local k = logKey(e)
            if not st.recent[k] then
                st.recent[k] = true
                st.order[#st.order + 1] = k
                if #st.order > 300 then st.recent[table.remove(st.order, 1)] = nil end
                local ic = e.interactioncomponent and to64(e.interactioncomponent) or 0
                items[#items + 1] = { cat = cat, t = round(e.time, 2), ti = e.title, tx = e.text,
                    en = (e.entityname ~= "") and e.entityname or nil, fa = (e.factionname ~= "") and e.factionname or nil,
                    mo = (e.money and e.money ~= 0) and e.money or nil, bo = (e.bonus and e.bonus ~= 0) and e.bonus or nil,
                    hl = e.highlighted or nil, ia = (e.interaction and e.interaction ~= "") and e.interaction or nil,
                    ic = ic ~= 0 and idstr(ic) or nil }
            end
        end
        if #items > 0 then
            local ck = newChunker("logbook", { cat = cat, total = n, initial = (fetch == CFG.log_initial) or nil })
            for _, it in ipairs(items) do chunkAdd(ck, it) end
            chunkFlush(ck, true)
            if not ck.sent_ok then ch.state.cats[cat] = nil end
        end
        return false
    end })

-------------------------------------------------------------------------------
-- Channel: ticker (on-screen notification history, incremental by id)

local tickerBuf = nil
defchan("ticker", { every = 1, max = 10, budget = 0.03,
    on_resync = function(ch) ch.state.seen = nil end,
    start = function(ch, now)
        local n = tonumber(S("t.num", C.GetNumTickerCache, "")) or 0
        if n <= 0 then return true end
        local first = ch.state.seen == nil
        ch.state.seen = ch.state.seen or {}
        local cnt = math.min(n, first and 30 or 10)
        if tickerBuf == nil then tickerBuf = ffi.new("TickerCacheEntry[30]") end
        local got = tonumber(S("t.get", C.GetTickerCache, tickerBuf, cnt, n - cnt + 1, cnt, "")) or 0
        local items = arr()
        for i = 0, got - 1 do
            local e = tickerBuf[i]
            local id = sfmt("%.0f", tonumber(e.id) or 0)
            if not ch.state.seen[id] then
                ch.state.seen[id] = true
                items[#items + 1] = { id = id, t = round(e.time, 2), cat = cstr(e.category), ti = cstr(e.title), tx = cstr(e.text) }
            end
        end
        if #items > 0 then
            if not send({ type = "ticker", items = items, total = n }) then ch.state.seen = nil end
        end
        return true
    end })

-------------------------------------------------------------------------------
-- Channel: messages (inbox)

local MSG_CATS = { "highprio", "lowprio" }
local msgBuf = nil
defchan("messages", { every = 5, max = 30, budget = 0.03,
    start = function(ch, now)
        local out, unread = arr(), {}
        if msgBuf == nil then msgBuf = ffi.new("MessageInfo[20]") end
        for _, cat in ipairs(MSG_CATS) do
            local n = tonumber(S("m.num", C.GetNumMessages, cat, false)) or 0
            unread[cat] = tonumber(S("m.unread", C.GetNumMessages, cat, true)) or 0
            local cnt = math.min(n, 20)
            if cnt > 0 then
                local got = tonumber(S("m.get", C.GetMessages, msgBuf, cnt, n - cnt + 1, cnt, cat)) or 0
                for i = 0, got - 1 do
                    local e = msgBuf[i]
                    local ic = to64(e.interactioncomponent)
                    out[#out + 1] = { id = sfmt("%.0f", tonumber(e.id) or 0), cat = cat, t = round(e.time, 2),
                        ti = cstr(e.title), tx = cstr(e.text), so = cstr(e.source), rd = e.isread and true or false,
                        hl = e.highlighted or nil, ia = cstr(e.interaction), ic = ic ~= 0 and idstr(ic) or nil,
                        mo = (tonumber(e.money) or 0) / 100 }
                end
            end
        end
        local m = { type = "messages", items = out, unread = unread }
        local js = json(m)
        if ch.resync or js ~= ch.state.last then
            if send(m) then ch.state.last = js end
        end
        return true
    end })

-------------------------------------------------------------------------------
-- Channel: missions (accepted)

defchan("missions", { every = 3, max = 20, budget = 0.05, steps = 2,
    start = function(ch, now)
        local n = tonumber(S("mi.num", GetNumMissions)) or 0
        return { n = n, i = 1, out = arr(), active = S("mi.active", GetActiveMission) }
    end,
    step = function(ch, job, now)
        for _ = 1, 5 do
            local i = job.i
            if i > job.n then
                send({ type = "missions", items = job.out })
                return true
            end
            job.i = i + 1
            local missionID, name, description, difficulty, threadtype, maintype, subtype, subtypename, faction, reward, rewardtext,
                  _, _, _, _, _, missiontime, _, abortable, disableguidance, associatedcomponent, alertlevel, hasobjective, threadmissionid =
                  S("mi.details", GetMissionDetails, i)
            if missionID ~= nil then
                local objtext, timeout, progressname, cur, max = S("mi.objective", GetMissionObjective, i)
                local mid = idstr(missionID)
                if mid then missionNames[mid] = name end
                local assoc = to64(associatedcomponent)
                local thread = to64(threadmissionid)
                job.out[#job.out + 1] = { id = mid, n = name, d = description, diff = difficulty, mt = maintype,
                    st = subtypename, fa = faction, rw = reward, rt = rewardtext,
                    dur = round((timeout and timeout ~= -1) and timeout or missiontime, 0),
                    act = (job.active ~= nil and i == job.active) or nil, ab = abortable or nil,
                    ob = objtext, pn = progressname, pc = cur, pm = max, al = alertlevel,
                    th = thread ~= 0 and idstr(thread) or nil,
                    ac = assoc ~= 0 and idstr(assoc) or nil,
                    acs = (assoc ~= 0 and sectorKnown(sectorOf(assoc), now)) and idstr(sectorOf(assoc)) or nil }
            end
        end
        return false
    end })

-------------------------------------------------------------------------------
-- Channel: offers (mission offers currently shown on the BBS / map)

defchan("offers", { every = 10, max = 60, budget = 0.05, steps = 2,
    start = function(ch, now)
        local n = tonumber(S("of.num", C.GetNumCurrentMissionOffers, true)) or 0
        local ids = {}
        if n > 0 then
            local buf = ffi.new("uint64_t[?]", n)
            n = tonumber(S("of.list", C.GetCurrentMissionOffers, buf, n, true)) or 0
            for i = 0, n - 1 do ids[#ids + 1] = sfmt("%.0f", tonumber(buf[i])) end
        end
        return { ids = ids, i = 1, out = arr() }
    end,
    step = function(ch, job, now)
        for _ = 1, 6 do
            local id = job.ids[job.i]
            if id == nil then
                local js = json(job.out)
                if ch.resync or js ~= ch.state.last then
                    if send({ type = "offers", items = job.out }) then ch.state.last = js end
                end
                return true
            end
            job.i = job.i + 1
            local lid = S("of.luaid", ConvertStringToLuaID, id)
            if lid ~= nil then
                local name, description, difficulty, threadtype, maintype, subtype, subtypename, faction, reward, rewardtext,
                      _, _, _, _, _, missiontime, duration, _, _, _, _, actor = S("of.details", GetMissionOfferDetails, lid)
                if name ~= nil then
                    local a64 = to64(actor)
                    job.out[#job.out + 1] = { id = id, n = name, d = description, diff = difficulty, mt = maintype,
                        st = subtypename, fa = faction, rw = reward, rt = rewardtext, dur = round(duration, 0),
                        s = (a64 ~= 0 and sectorKnown(sectorOf(a64), now)) and idstr(sectorOf(a64)) or nil }
                end
            end
        end
        return false
    end })

-------------------------------------------------------------------------------
-- Channel: factions (relations + licences)

defchan("factions", { every = 20, max = 120, budget = 0.04, steps = 2,
    start = function(ch, now)
        local lib = S("f.lib", GetLibrary, "factions")
        if type(lib) ~= "table" then return true end
        return { list = lib, i = 1, out = arr() }
    end,
    step = function(ch, job, now)
        for _ = 1, 2 do
            local f = job.list[job.i]
            if f == nil then
                local js = json(job.out)
                if ch.resync or js ~= ch.state.last or (now - (ch.state.at or 0)) > 120 then
                    if send({ type = "factions", items = job.out }) then ch.state.last = js; ch.state.at = now end
                end
                return true
            end
            job.i = job.i + 1
            local id = type(f) == "table" and f.id or nil
            if type(id) == "string" and id ~= "player" then
                local short, enemy, hostile, locked, color = S("f.data", GetFactionData, id, "shortname", "isenemy", "ishostile", "isrelationlocked", "color")
                local rr2 = S("f.relname", C.GetUIRelationName, "player", id)
                local e = { id = id, n = f.name, sn = short, rel = S("f.rel", GetUIRelation, id),
                            rn = rr2 and cstr(rr2.name) or nil, e = enemy or nil, h = hostile or nil, lk = locked or nil }
                if type(color) == "table" then e.col = { r = color.r, g = color.g, b = color.b } end
                local lic = S("f.licences", GetOwnLicences, id)
                if type(lic) == "table" then
                    local ls = arr()
                    for _, l in ipairs(lic) do
                        if type(l) == "table" then
                            ls[#ls + 1] = { t = l.type, n = l.name, has = S("f.has", HasLicence, "player", l.type, id) and true or false,
                                            pr = l.price, mr = l.minrelation }
                        end
                    end
                    e.lic = ls
                end
                job.out[#job.out + 1] = e
            end
        end
        return false
    end })

-------------------------------------------------------------------------------
-- Channel: economy (player account, last game hour)

defchan("economy", { every = 30, max = 300, budget = 0.04, steps = 2,
    start = function(ch, now)
        local pid = to64(S("p.id", C.GetPlayerID))
        if pid == 0 then return true end
        local gt = tonumber(S("p.gametime", C.GetCurrentGameTime)) or 0
        local t0 = math.max(0, gt - 3600)
        local n = tonumber(S("e.num", C.GetNumTransactionLog, pid, t0, gt)) or 0
        n = math.min(n, 3000)
        local job = { n = 0, i = 0, inc = 0, exp = 0, bytype = {}, top = {}, partners = {}, gt = gt, t0 = t0 }
        if n > 0 then
            job.buf = ffi.new("TransactionLogEntry[?]", n)
            job.n = tonumber(S("e.get", C.GetTransactionLog, job.buf, n, pid, t0, gt)) or 0
        end
        return job
    end,
    step = function(ch, job, now)
        local stop = math.min(job.i + 300, job.n)
        for i = job.i, stop - 1 do
            local e = job.buf[i]
            local money = (tonumber(e.money) or 0) / 100
            if money >= 0 then job.inc = job.inc + money else job.exp = job.exp - money end
            local tn = cstr(e.eventtypename) or cstr(e.eventtype) or "?"
            job.bytype[tn] = (job.bytype[tn] or 0) + money
            local partner = cstr(e.partnername) or ""
            if partner ~= "" and cstr(e.ware) ~= "" then
                local key = partner .. " (" .. (cstr(e.partneridcode) or "") .. ")"
                job.partners[key] = (job.partners[key] or 0) + money
            end
            local top = job.top
            if #top < 10 or math.abs(money) > math.abs(top[#top].mo) then
                top[#top + 1] = { t = round(e.time, 0), mo = money, ty = tn, pa = partner, w = cstr(e.ware), am = tonumber(e.amount) }
                table.sort(top, function(a, b) return math.abs(a.mo) > math.abs(b.mo) end)
                if #top > 10 then top[#top] = nil end
            end
        end
        job.i = stop
        if job.i >= job.n then
            for _, t in ipairs(job.top) do
                if t.w and t.w ~= "" then t.wn = S("e.ware", GetWareData, t.w, "name") end
            end
            local partners = {}
            for k, v in pairs(job.partners) do partners[#partners + 1] = { n = k, mo = v } end
            table.sort(partners, function(a, b) return a.mo > b.mo end)
            while #partners > 8 do partners[#partners] = nil end
            local bytype = {}
            for k, v in pairs(job.bytype) do bytype[#bytype + 1] = { n = k, mo = v } end
            table.sort(bytype, function(a, b) return math.abs(a.mo) > math.abs(b.mo) end)
            job.buf = nil
            send({ type = "economy", window = 3600, gt = job.gt, count = job.n, inc = round(job.inc, 0), exp = round(job.exp, 0),
                   bytype = arr(bytype), top = arr(job.top), partners = arr(partners),
                   money = S("p.money", GetPlayerMoney) })
            return true
        end
        return false
    end })

-------------------------------------------------------------------------------
-- Channel: stats (cost of every channel; also does the adaptive throttling)

defchan("stats", { every = 2, max = 2, budget = 1,
    start = function(ch, now)
        local span = now - (ch.state.last or now)
        ch.state.last = now
        local frames = math.max(1, W.frame_n)
        local chs = {}
        for _, c in ipairs(CH_ORDER) do
            local avg = c.win_ms / frames
            local aops = c.win_ops / frames
            chs[c.name] = { avg = round(avg, 4), max = round(c.win_max, 3), pass = round(c.last_pass_ms, 3),
                            ops = round(aops, 2), pops = c.last_pass_ops,
                            iv = round(c.interval, 2), err = c.errors, off = c.disabled or nil, runs = c.runs,
                            le = c.last_err }
            -- throttle: sustained over budget -> slower; well under -> back toward the base rate.
            -- Measured in ms with a real clock, otherwise in engine calls (budget * ops_per_ms).
            if c ~= ch then
                local load = HIRES and avg or (aops / CFG.ops_per_ms)
                if load > c.budget and c.interval < c.max_interval then
                    c.interval = math.min(c.interval * 1.5, c.max_interval)
                elseif load < c.budget / 3 and c.interval > c.base then
                    c.interval = math.max(c.interval / 1.25, c.base)
                end
            end
            c.win_ms, c.win_max, c.win_ops = 0, 0, 0
        end
        local srcoff, srcerr = arr(), {}
        for name, s in pairs(SRC) do
            if s.off then srcoff[#srcoff + 1] = name end
            if s.err > 0 then srcerr[name] = s.err end
        end
        send({ type = "stats", span = round(span, 2), frames = W.frame_n,
               frame = { avg = round(W.frame_ms_sum / frames, 4), max = round(W.frame_ms_max, 3),
                         ops = round((W.frame_ops_sum or 0) / frames, 2) },
               ch = chs, srcoff = srcoff, srcerr = srcerr, pending = W.pending, sent = W.nsent,
               bytes = W.nbytes, dropped = W.ndrop, wfail = W.nfail, cmds = W.ncmd,
               gates = W.gates_state, ngates = W.gates_n, gates_md = W.gates_md, gates_rx = W.gates_rx, gates_hw = W.gates_hw,
               hk = W.hk_registered, timer = TIMER, hires = HIRES,
               nframe = W.n_frame, nmd = W.n_md, watch = W.watch ~= 0 and idstr(W.watch) or nil })
        W.frame_ms_sum, W.frame_ms_max, W.frame_n, W.frame_ops_sum = 0, 0, 0, 0
        return true
    end })

-------------------------------------------------------------------------------
-- Commands (server -> game). Format, one per line: "cmd <seq> <name> [arg ...]"

local function findMenu(name)
    local menus = rawget(_G, "Menus")
    if type(menus) ~= "table" then return nil end
    for _, m in ipairs(menus) do
        if type(m) == "table" and m.name == name then return m end
    end
    return nil
end

local function otherMenuOpen()
    local menus = rawget(_G, "Menus")
    if type(menus) ~= "table" then return nil end
    for _, m in ipairs(menus) do
        if type(m) == "table" and m.shown and m.name ~= "MapMenu" then return m.name end
    end
    return nil
end

local function validId(s)
    local n = to64(s)
    if n == 0 then return nil end
    if not S("c.valid", IsValidComponent, n) then return nil end
    return n
end

local function playerShip(s)
    local n = validId(s)
    if not n then return nil, "érvénytelen objektum" end
    if not S("c.isship", C.IsComponentClass, n, "ship") then return nil, "nem hajó" end
    if not GetComponentData(n, "isplayerowned") then return nil, "nem saját hajó" end
    return n
end

local COMMANDS = {}

COMMANDS.resync = function(args)
    markAllResync()
    return true, "újraküldés"
end

COMMANDS.watch = function(args)
    local n = to64(args[1])
    if n ~= 0 and not S("c.issector", C.IsComponentClass, n, "sector") then return false, "nem szektor" end
    if n ~= 0 and not sectorKnown(n) then return false, "ismeretlen szektor" end
    W.watch = n
    if CH.sector then CH.sector.next_due = 0 end
    return true, n ~= 0 and "figyelt szektor beállítva" or "figyelt szektor törölve"
end

COMMANDS.reenable = function(args)
    for _, ch in ipairs(CH_ORDER) do ch.disabled = false; ch.errors = 0 end
    for _, s in pairs(SRC) do s.off = false; s.err = 0; s.consec = 0 end
    return true, "csatornák újraengedélyezve"
end

-- open the real in-game map focused on (and selecting) an object or sector.
-- vanilla: OpenMenu("MapMenu", { 0, 0, true, component }) - menu_playerinfo.lua:856,
-- param[4] = focus component + selectfocuscomponent (menu_map.lua:29435-29438);
-- map already open: C.SetFocusMapComponent(menu.holomap, component, true) (menu_map.lua:2727).
local function openMap(args)
    local n = validId(args[1])
    if not n then return false, "érvénytelen objektum" end
    local mm = findMenu("MapMenu")
    if mm and mm.shown and mm.holomap and mm.holomap ~= 0 then
        S("cmd.focus", C.SetFocusMapComponent, mm.holomap, n, true)
        return true, "térkép fókusz"
    end
    local other = otherMenuOpen()
    if other then return false, "másik menü van nyitva (" .. tostring(other) .. ")" end
    local ok, e = pcall(OpenMenu, "MapMenu", { 0, 0, true, luaid(n) }, nil)
    if not ok then return false, "OpenMenu hiba: " .. tostring(e) end
    return true, "térkép megnyitva"
end
COMMANDS.openmap = openMap
COMMANDS.select = openMap

-- C.SetSofttarget(component, "") - menu_map.lua:983, used by mycu_map_hotkeys map_hotkeys.lua:159
COMMANDS.target = function(args)
    local n = validId(args[1])
    if not n then return false, "érvénytelen objektum" end
    local r = S("cmd.target", C.SetSofttarget, n, "")
    return r and true or false, r and "célpont beállítva" or "a játék elutasította a célpontot"
end

-- C.SetGuidance(component, ffi.new("UIPosRot", 0)) - menu_playerinfo.lua:864-868
COMMANDS.guidance = function(args)
    local n = validId(args[1])
    if not n then return false, "érvénytelen objektum" end
    local ok = pcall(function() C.SetGuidance(n, ffi.new("UIPosRot", 0)) end)
    return ok, ok and "útvonal beállítva" or "SetGuidance hiba"
end
COMMANDS.guidance_end = function(args)
    local ok = pcall(function() C.EndGuidance() end)
    return ok, ok and "útvonal törölve" or "EndGuidance hiba"
end

-- "stop": menu.orderRemove(ship, removedefaultorder=true, removeassignment=false, removedockorder=false)
-- menu_interactmenu.lua:883-915 (RemoveOrder loop, ResetOrderLoop, default order -> Wait)
COMMANDS.stop = function(args)
    local ship, why = playerShip(args[1])
    if not ship then return false, why end
    local n = tonumber(C.GetNumOrders(ship)) or 0
    local buf = ffi.new("Order[?]", math.max(n, 1))
    n = tonumber(C.GetOrders(buf, n, ship)) or 0
    local assigncommanderfound = false
    for i = n, 1, -1 do
        local isdocked, isdocking = GetComponentData(ship, "isdocked", "isdocking")
        local orderdef = ffi.string(buf[i - 1].orderdef)
        if (i == 1) and ((orderdef == "DockAndWait") and (isdocked or isdocking)) then
            -- keep: removing it would create an undock order (vanilla comment)
        elseif (not assigncommanderfound) and (orderdef == "AssignCommander") then
            assigncommanderfound = true
        else
            C.RemoveOrder(ship, i, false, false)
        end
    end
    C.ResetOrderLoop(ship)
    local cur = ffi.new("Order")
    if C.GetDefaultOrder(cur, ship) then
        local def = ffi.string(cur.orderdef)
        if def ~= "Wait" and def ~= "DockAndWait" then
            C.CreateOrder(ship, "Wait", true)
            C.EnablePlannedDefaultOrder(ship, false)
        end
    end
    return true, "parancsok törölve, várakozik"
end

-- "flyto": the map menu's own menu.orderMoveWait (menu_map.lua:3449-3468; the right-click variant is
-- menu_interactmenu.lua:831-851): IsOrderSelectableFor("MoveWait") + CreateOrder(ship, "MoveWait",
-- { destination = { sector, { x, y, z } } }, false, false, false) - sector centre, appended (not prioritised)
COMMANDS.flyto = function(args)
    local ship, why = playerShip(args[1])
    if not ship then return false, why end
    local sec = validId(args[2])
    if not sec or not C.IsComponentClass(sec, "sector") then return false, "érvénytelen szektor" end
    if (not C.IsOrderSelectableFor("MoveWait", ship)) or (not GetComponentData(ship, "assignedpilot")) then
        return false, "a hajó nem kaphat repülési parancsot"
    end
    local params = { destination = { luaid(sec), { 0, 0, 0 } } }
    CreateOrder(ship, "MoveWait", params, false, false, false)
    return true, "repülés a szektorba"
end

-- "details": read-only extra data about ONE object the player can see, for the info panel.
-- Same visibility rule as the sector channel; cargo like the map's info panel (menu_map.lua:20192-20215):
-- GetComponentData(obj, "cargo") (menu_map.lua:20210), ware list only if
-- C.IsInfoUnlockedForPlayer(obj, "storage_warelist"), amounts only if "storage_amounts".
COMMANDS.details = function(args, seq)
    local n = validId(args[1])
    if not n then return false, "érvénytelen objektum" end
    local cls = className(n)
    local owner, isplayer, known, radar, ownername, hull, shield, purpose, code =
        GetComponentData(n, "owner", "isplayerowned", "isknown", "isradarvisible", "ownername", "hullpercent", "shieldpercent", "primarypurpose", "idcode")
    if not objVisible(n, cls, isplayer, known, radar) then return false, "nem látható objektum" end
    local sec = sectorOf(n)
    if not sectorKnown(sec) then return false, "nem látható objektum" end
    local ic = (SHIP_CLASSES[cls] or cls == "station") and S("d.icon", GetComponentData, n, "icon") or iconOf(n, cls)
    local d = { type = "details", seq = tonumber(seq), id = idstr(n), n = knownName(n), c = cls, o = owner,
                on = ownername, pl = isplayer or nil, hull = round(hull, 0), shield = round(shield, 0), p = purpose,
                code = code, s = idstr(sec), ic = (type(ic) == "string" and ic ~= "") and ic or nil }
    if SHIP_CLASSES[cls] or cls == "station" then
        local wl = isplayer or S("d.wl", C.IsInfoUnlockedForPlayer, n, "storage_warelist")
        local am = isplayer or S("d.am", C.IsInfoUnlockedForPlayer, n, "storage_amounts")
        d.cwl, d.cam = wl and true or false, am and true or false
        if wl then
            local cargo = S("d.cargo", GetComponentData, n, "cargo")
            if type(cargo) == "table" then
                local list = arr()
                for ware, amount in pairs(cargo) do
                    list[#list + 1] = { w = ware, n = S("e.ware", GetWareData, ware, "name"), a = am and amount or nil }
                end
                table.sort(list, function(a, b) return (a.a or 0) > (b.a or 0) end)
                while #list > 40 do list[#list] = nil end
                d.cargo = list
            end
        end
    end
    if isplayer and SHIP_CLASSES[cls] then
        local def, oname, ostate, nord, isdef = currentOrder(n)
        d.od, d.oname, d.os, d.oq, d.odf = def, oname, ostate, nord, isdef or nil
        local cmd = to64(S("pr.cmd", GetCommander, n))
        d.cmd = cmd ~= 0 and idstr(cmd) or nil
        d.rr = radarRange(n, realtime())
        d.orders = orderQueue(n)
    elseif isplayer and cls == "station" then
        d.money = round(S("d.money", GetComponentData, n, "money"), 0)
        d.mods = tonumber(S("pr.modules", C.GetNumStationModules, n, false, false))
    end
    send(d, false)
    return true, "részletek"
end

local function ack(seq, name, ok, msg)
    send({ type = "ack", seq = tonumber(seq), cmd = name, ok = ok and true or false, msg = msg }, false)
end

local function runCommand(line)
    local seq, name, rest = string.match(line, "^cmd%s+(%d+)%s+([%w_]+)%s*(.*)$")
    if not seq then
        if line ~= "" then warn("cmdparse", "ignored pipe line: " .. ssub(line, 1, 80)) end
        return
    end
    W.ncmd = W.ncmd + 1
    if not CFG.allow[name] then
        ack(seq, name, false, "a parancs nincs engedélyezve a modban (x4_companion.lua CFG.allow)")
        return
    end
    local fn = COMMANDS[name]
    if not fn then ack(seq, name, false, "ismeretlen parancs"); return end
    local args = {}
    for a in string.gmatch(rest or "", "%S+") do args[#args + 1] = a end
    local ok, r1, r2 = pcall(fn, args, seq)
    if not ok then
        warn("cmd:" .. name, "command " .. name .. " failed: " .. tostring(r1))
        ack(seq, name, false, "hiba: " .. tostring(r1))
    else
        ack(seq, name, r1, r2)
    end
end

onRead = function(data)
    if data == "ERROR" or data == nil then
        W.reading = false      -- pipe closed; Schedule_Read again after the next successful write
        return
    end
    for line in string.gmatch(tostring(data), "[^\r\n]+") do
        local ok, e = pcall(runCommand, line)
        if not ok then warn("cmd", "command handling failed: " .. tostring(e)) end
    end
end

-------------------------------------------------------------------------------
-- In-game hotkeys (Native Hotkey API, optional): each press is sent to the browser

-- ids are stable (the player's key bindings are stored per id); names describe the v1.1 UI
local HOTKEYS = {
    { "panel_next",    "Companion: következő nézet" },
    { "view_prev",     "Companion: előző nézet" },
    { "view_map",      "Companion: vissza a térképre" },
    { "view_toggle",   "Companion: galaxis / szektor" },
    { "zoom_in",       "Companion: nagyítás" },
    { "zoom_out",      "Companion: kicsinyítés" },
    { "zoom_fit",      "Companion: illesztés (minden látsszon)" },
    { "log_down",      "Companion: lista lefelé" },
    { "log_up",        "Companion: lista felfelé" },
    { "list_select",   "Companion: kijelölés a listában" },
    { "details",       "Companion: részletek nyit / zár" },
    { "alert_next",    "Companion: következő riasztás" },
    { "ship_next",     "Companion: következő saját hajó" },
    { "ship_prev",     "Companion: előző saját hajó" },
    { "show_selected", "Companion: játékban kijelölt / célzott objektum" },
    { "auto",          "Companion: vissza a hajómra (automata)" },
    { "ack_alerts",    "Companion: riasztások nyugtázása" },
}

local function onHotkey(action, params)
    local obj = (type(params) == "table") and params.object or nil
    local o64 = to64(obj)
    send({ type = "hotkey", action = action, obj = o64 ~= 0 and idstr(o64) or nil, t = realtime() }, false)
end

local function registerHotkeys()
    W.hk_seen = true
    if not CFG.hotkeys then return end
    local api = rawget(_G, "HotkeyApi")
    if type(api) ~= "table" or type(api.RegisterAction) ~= "function" then return end
    local n = 0
    for _, hk in ipairs(HOTKEYS) do
        local action = hk[1]
        local ok = pcall(api.RegisterAction, {
            id = "x4companion_" .. action, version = 1, area = "map;pilot;fps",
            isObjectRequired = false, name = hk[2],
            actionLua = function(p) pcall(onHotkey, action, p) end,
        })
        if ok then n = n + 1 end
    end
    W.hk_registered = n
    info("hotkeys", "registered " .. n .. " hotkeys with the Native Hotkey API")
end

-------------------------------------------------------------------------------
-- Tick

local function tick(src)
    local now = realtime()
    if src == "md" then
        -- MD fallback: only when the frame sources produced nothing for a few MD ticks
        W.md_since_frame = W.md_since_frame + 1
        if W.md_since_frame < CFG.md_fallback then return end
        W.n_md = W.n_md + 1
    else
        if now == W.last_frame_tick then return end   -- two frame sources may call in the same frame
        W.last_frame_tick = now
        W.md_since_frame = 0
        W.n_frame = W.n_frame + 1
    end
    W.src = src

    if not W.connected then
        if (now - W.last_hello) >= CFG.hello_every or now < W.last_hello then
            W.last_hello = now
            W.session = W.session + 1
            local allow = arr()
            for k, v in pairs(CFG.allow) do if v then allow[#allow + 1] = k end end
            table.sort(allow)
            send({ type = "hello", mod = MOD, ver = VERSION, session = W.session, allow = allow,
                   hotkeys = W.hk_registered, loglib = type(rawget(_G, "UIInfo")) == "function",
                   timer = TIMER }, false)
        end
        return
    end
    -- late hotkey registration (the API raises Register_Request after a load; if that
    -- happened before this file ran, try once directly after 15 s)
    if not W.hk_seen and not W.hk_requested and now > 15 then
        W.hk_requested = true
        pcall(registerHotkeys)
    end
    schedule(now)
end

local function onFrame()
    if W.in_tick then return end
    W.in_tick = true
    local ok, e = pcall(tick, "frame")
    W.in_tick = false
    if not ok then err("tick", "tick failed: " .. tostring(e)) end
end

local function onMdTick()
    if W.in_tick then return end
    W.in_tick = true
    local ok, e = pcall(tick, "md")
    W.in_tick = false
    if not ok then err("tick", "md tick failed: " .. tostring(e)) end
end

-------------------------------------------------------------------------------
-- Init (the game loads ui.xml Lua but does not call any init for us -> call it here)

local function init()
    if W.init_done then return end
    W.init_done = true

    local ok1, e1 = pcall(SetScript, "onUpdate", onFrame)
    if not ok1 then err("init1", "SetScript onUpdate failed: " .. tostring(e1)) end

    local ok2, T = pcall(require, "extensions.sn_mod_support_apis.ui.time.Interface")
    if ok2 and type(T) == "table" and type(T.Register_NewFrame_Callback) == "function" then
        pcall(T.Register_NewFrame_Callback, onFrame)
    else
        warn("init2", "SN Time API not available: " .. tostring(T))
    end

    pcall(RegisterEvent, "x4companion.mdTick", onMdTick)
    pcall(RegisterEvent, "x4companion.gates", onGates)
    pcall(RegisterEvent, "x4companion.sectorinfo", onSectorInfo)
    -- v1.2: MD (x4_companion_gates.xml GateDiscovered) - a gate / highway entry was just discovered:
    -- re-collect the gate list now (at most once a second)
    pcall(RegisterEvent, "x4companion.gatesdirty", function()
        local now = realtime()
        if (now - (W.gates_requested or -1e9)) >= 1 then W.gates_due = 0 end
    end)
    pcall(RegisterEvent, "HotkeyApi.Register_Request", function() pcall(registerHotkeys) end)

    local startline = "v" .. VERSION .. " loaded (pipe \\\\.\\pipe\\" .. CFG.pipe_name .. ", timer " .. TIMER .. ")"
    if type(rawget(_G, "UIInfo")) == "function" then
        info("start", startline)
    else
        pcall(DebugError, MOD .. ": " .. startline .. " - further info lines need the Lua Log API")
    end
end

local okInit, errInit = pcall(init)
if not okInit then pcall(DebugError, MOD .. ": init failed: " .. tostring(errInit)) end

-- test harness access (nil in the game unless a test set the hook)
if rawget(_G, "__X4COMPANION_TEST_C") then
    __X4COMPANION_TEST = { W = W, CH = CH, CFG = CFG, SRC = SRC, onFrame = onFrame, onMdTick = onMdTick,
                           onRead = onRead, json = json, utf8clean = utf8clean, registerHotkeys = registerHotkeys,
                           onGates = onGates, TIMER = TIMER }
end
