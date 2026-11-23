--[[ mock_game.lua - a fake X4 9.00 "menus" Lua environment for running dev\x4_companion\ui\x4_companion.lua
offline under LuaJIT 2.1 (lupa). It provides the ffi types (declared first, as the vanilla menus do),
a mock ffi.C table, the Lua globals the bridge uses, the SN Pipes/Time modules, the Native Hotkey API
and the MD gate round trip. It is NOT the game: it checks the bridge's own logic, syntax, JSON
output, time slicing and error containment - not whether the engine functions behave like this. ]]

local ffi = require("ffi")
MOCK = { now = 100.0, out = {}, debug = {}, info = {}, events = {}, onupdate = nil, opened = {}, targets = {},
         write_fail = false, calls = {}, raise = {}, orders = {}, guidance = {} }

-- vanilla-identical declarations (the bridge must not redeclare these)
ffi.cdef([[
typedef uint64_t UniverseID;
typedef uint64_t MissionID;
typedef uint64_t MessageID;
typedef uint64_t TickerCacheID;
typedef struct { float x; float y; float z; float yaw; float pitch; float roll; } UIPosRot;
typedef struct { UniverseID softtargetID; const char* softtargetConnectionName; uint32_t messageID; } SofttargetDetails2;
typedef struct { float speed; float boostspeed; float travelspeed; } SpeedInfo;
typedef struct { const char* ware; int32_t current; int32_t max; } WareYield;
typedef struct { size_t queueidx; const char* state; const char* statename; const char* orderdef; size_t actualparams; bool enabled; bool isinfinite; bool issyncpointreached; bool istemporder; } Order;
typedef struct { const char* id; const char* name; const char* icon; const char* description; const char* category; const char* categoryname; bool infinite; uint32_t requiredSkill; } OrderDefinition;
typedef struct { uint32_t current; uint32_t capacity; uint32_t optimal; uint32_t available; uint32_t maxavailable; double timeuntilnextupdate; } WorkForceInfo;
typedef struct { TickerCacheID id; double time; const char* category; const char* title; const char* text; } TickerCacheEntry;
typedef struct { MessageID id; double time; const char* category; const char* title; const char* text; const char* source; UniverseID sourcecomponent; const char* interaction; UniverseID interactioncomponent; const char* interactiontext; const char* interactionshorttext; const char* cutscenekey; const char* entityname; const char* factionname; int64_t money; int64_t bonus; bool highlighted; bool isread; } MessageInfo;
typedef struct { double time; int64_t money; int64_t entryid; const char* eventtype; const char* eventtypename; UniverseID partnerid; const char* partnername; const char* partneridcode; int64_t tradeentryid; const char* tradeeventtype; const char* tradeeventtypename; UniverseID buyerid; UniverseID sellerid; const char* ware; uint32_t amount; int64_t price; bool complete; } TransactionLogEntry;
typedef struct { const char* name; const char* colorid; } RelationRangeInfo;
]])

local KEEP = {}             -- keeps Lua strings alive that cdata char* fields point to
local function cs(s) KEEP[#KEEP + 1] = s; return s end

-------------------------------------------------------------------------------- world
local W = { objs = {}, player = 1001, ship = 2001, sector = 501, sectors = {}, clusters = {} }
local function obj(id, t) t.id = id; W.objs[id] = t; return t end
local nextid = 3000
local function nid() nextid = nextid + 7; return nextid end

-- galaxy: 10 clusters, 2 sectors each
for c = 1, 10 do
    local cid = 400 + c
    obj(cid, { class = "cluster", name = "Cluster " .. c, macro = "cluster_" .. c .. "_macro", x = c * 1e7, z = c * 5e6 })
    W.clusters[#W.clusters + 1] = cid
    local secs = {}
    for s = 1, 2 do
        local sid = 500 + c * 2 + s - 2
        obj(sid, { class = "sector", name = (c == 3 and s == 1) and "Bad \255 Name \27[icon]\27X \"q\" \\ end" or ("Sector " .. c .. "-" .. s),
                   macro = "cluster_" .. c .. "_sector00" .. s .. "_macro", owner = (c % 3 == 0) and "argon" or "teladi",
                   x = s * 3e6, z = 0, cluster = cid })
        secs[#secs + 1] = sid
    end
    W.sectors[cid] = secs
end
W.sector = 501
obj(W.player, { class = "player", name = "Mock Player", sector = W.sector })
obj(W.ship, { class = "ship_m", name = "Player Ship", sector = W.sector, owner = "player", hull = 90, shield = 70, code = "PLY-001", isplayerowned = true, assignedpilot = 1 })

local FACTIONS = { "argon", "teladi", "paranid", "xenon", "badfaction", "player" }
W.byowner = {}
local function addobj(sector, owner, class, name, extra)
    local id = nid()
    local o = obj(id, { class = class, name = name, sector = sector, owner = owner, x = (id % 997) * 100, z = (id % 431) * 300,
                        hull = 50 + id % 50, shield = id % 100, code = "C" .. id, isplayerowned = owner == "player", isknown = true,
                        isinliveview = (id % 3) ~= 0, purpose = "trade", macro = "ship_mock_macro", assignedpilot = 1 })
    if extra then for k, v in pairs(extra) do o[k] = v end end
    W.byowner[owner] = W.byowner[owner] or {}
    W.byowner[owner][#W.byowner[owner] + 1] = id
    return o
end
W.playerships, W.playerstations = {}, {}
for i = 1, 320 do
    local sec = 501 + (i % 19)
    local o = addobj(sec, "player", (i % 5 == 0) and "ship_l" or "ship_s", (i == 7) and "Evil \"\\\255\254 name\27[x]" or ("Own " .. i))
    W.playerships[#W.playerships + 1] = o.id
end
for i = 1, 22 do
    local o = addobj(501 + (i % 19), "player", "station", "Own Station " .. i)
    W.playerstations[#W.playerstations + 1] = o.id
end
for _, f in ipairs({ "argon", "teladi", "paranid", "xenon" }) do
    for i = 1, 90 do addobj(W.sector, f, (i % 9 == 0) and "station" or "ship_m", f .. " " .. i) end
end
-- undiscovered content: must never leave the bridge
W.objs[520].known = false
W.objs[520].name = "SECRET_SECTOR"
MOCK.secretstation = addobj(W.sector, "argon", "station", "SECRET_STATION", { isknown = false }).id
W.secretship = addobj(W.sector, "xenon", "ship_l", "SECRET_SHIP", { isinliveview = false, live = false }).id
MOCK.secretship = W.secretship
for i = 1, 3 do addobj(W.sector, "player", "satellite", "Own Satellite " .. i) end
for i = 1, 12 do addobj(W.sector, "ownerless", "navbeacon", "Beacon " .. i) end
MOCK.secret2 = addobj(520, "argon", "station", "SECRET_STATION_2").id
W.gates = {}
do
    local a = addobj(501, "ownerless", "gate", "Gate to the unknown")
    local b = addobj(520, "ownerless", "gate", "SECRET_GATE")
    a.destination, b.destination = b.id, a.id
    W.gates[#W.gates + 1] = a.id; W.gates[#W.gates + 1] = b.id
    W.unknowngate = a.id
end
for i = 1, 6 do
    local a = addobj(500 + i, "ownerless", "gate", "Gate " .. i)
    local b = addobj(501 + i, "ownerless", "gate", "Gate " .. i .. "b")
    a.destination, b.destination = b.id, a.id
    W.gates[#W.gates + 1] = a.id; W.gates[#W.gates + 1] = b.id
end

-- v1.3 guidance targets: a station two jumps away (503), a zone (position target), a room inside a station
MOCK.gdt = {}
MOCK.gdt.station503 = addobj(503, "argon", "station", "Target Station 503").id
MOCK.gdt.zone = obj(nid(), { class = "zone", name = "Zone", sector = 501, x = 70000, z = -30000 }).id
do
    local host = addobj(501, "argon", "station", "Host Station")
    MOCK.gdt.host = host.id
    MOCK.gdt.room = obj(nid(), { class = "room", name = "Repair Terminal", sector = 501, container = host.id, x = 1, z = 1, isknown = true }).id
end

-- v1.3.1 regression: the live "Operation Draco" route (2026-11-23) - two gate hops with a local highway in each
-- sector between them, the last gate leads to a gate the player has not discovered (isknown = false) in a known
-- sector. MOCK.draco1_30 = what the 1.30 MD hand-over produced (both gate ends per hop -> A, B, B, A; a lane's
-- entry/exit three times); MOCK.draco = the expected clean route.
do
    local function g(sec, cls, x, z, extra) local o = addobj(sec, "ownerless", cls, cls .. " " .. sec, extra); o.x, o.z = x, z; return o.id end
    local A = g(501, "gate", 97603, -67126)
    local B = g(502, "gate", -72404, -23213)
    local he1 = g(502, "highwayentrygate", -19500, -65000)
    local hx1 = g(502, "highwayexitgate", 40500, 85000)
    local Cg = g(502, "gate", 40000, 85000)
    local D = g(503, "gate", 50000, -110000)
    local he2 = g(503, "highwayentrygate", 50500, -110000)
    local hx2 = g(503, "highwayexitgate", 50500, 120000)
    local E = g(503, "gate", -94977, 21304)
    local F = g(504, "gate", 1000, 2000, { isknown = false })
    MOCK.draco1_30 = { A, B, B, A, he1, hx1, he1, hx1, he1, hx1, Cg, D, D, Cg, he2, hx2, he2, hx2, E, F, F, E }
    MOCK.draco = { A, B, he1, hx1, Cg, D, he2, hx2, E, F }
    MOCK.dracoT = addobj(504, "argon", "station", "Draco Target").id
end

-------------------------------------------------------------------------------- ffi.C mock
local function n64(v) return tonumber(v) end
local function O(id) return W.objs[n64(id)] end
local function count(name) MOCK.calls[name] = (MOCK.calls[name] or 0) + 1 end
local C = setmetatable({}, { __index = function(t, k)
    error("mock C function missing: " .. tostring(k))
end })
C.GetPlayerID = function() count("GetPlayerID"); return W.player end
C.GetPlayerOccupiedShipID = function() return W.ship end
C.GetContextByClass = function(id, cls, inc)
    local o = O(id); if not o then return 0 end
    if cls == "sector" then return o.sector or (o.class == "sector" and n64(id)) or 0 end
    if cls == "container" then return o.container or 0 end
    return 0
end
C.GetObjectPositionInSector = function(id)
    local o = O(id) or {}
    return ffi.new("UIPosRot", { o.x or 0, 0, o.z or 0, 0.5, 0, 0 })
end
C.GetComponentName = function(id) local o = O(id); return cs(o and o.name or "") end
C.GetComponentClass = function(id) local o = O(id); return cs(o and o.class or "") end
C.IsComponentClass = function(id, cls)
    local o = O(id); if not o then return false end
    if cls == "ship" then return o.class:sub(1, 5) == "ship_" end
    return o.class == cls
end
C.IsGamePaused = function() return MOCK.paused or false end
C.GetPlayerName = function() return "Mock \"Captain\"" end
C.GetPlayerFactionName = function() return "Player" end
C.GetCurrentGameTime = function() return 5000 + MOCK.now end
C.GetSofttarget2 = function() return ffi.new("SofttargetDetails2", { MOCK.softtarget or 0, nil, 0 }) end
C.GetDefensibleSpeeds = function() return ffi.new("SpeedInfo", { 300, 600, 4000 }) end
C.GetDistanceBetween = function() return 1234.5 end
C.GetPositionalOffset = function(id) local o = O(id) or {}; return ffi.new("UIPosRot", { o.x or 0, 0, o.z or 0, 0, 0, 0 }) end
C.GetNumDiscoveredSectorResources = function(id) return (n64(id) % 2 == 0) and 2 or 0 end
C.GetDiscoveredSectorResources = function(buf, n, id)
    for i = 0, n - 1 do buf[i].ware = cs(i == 0 and "ore" or "silicon"); buf[i].current = 50; buf[i].max = 100 end
    return n
end
-- v1.2 resource areas: an ore blob, a silicon blob and an (undiscovered) nividium blob in every sector
MOCK.mineable_calls = 0
local function mineablesAt(pos)
    local out = {}
    local function blob(ware, cx, cz, r, amt)
        local d = math.sqrt((pos.x - cx) ^ 2 + (pos.z - cz) ^ 2)
        if d < r then out[#out + 1] = { ware, math.floor(amt * (1 - d / r)) + 1 } end
    end
    blob("ore", 50000, 30000, 40000, 80)
    blob("silicon", -60000, -20000, 30000, 60)
    blob("nividium", 0, 120000, 30000, 90)
    return out
end
C.GetNumMineablesAtSectorPos = function(sec, pos) MOCK.mineable_calls = MOCK.mineable_calls + 1; return #mineablesAt(pos) end
C.GetMineablesAtSectorPos = function(buf, n, sec, pos)
    MOCK.mineable_calls = MOCK.mineable_calls + 1
    local m = mineablesAt(pos)
    for i = 1, math.min(n, #m) do buf[i - 1].wareid = cs(m[i][1]); buf[i - 1].amount = m[i][2] end
    return math.min(n, #m)
end
-- v1.2 local highways: one lane, spline nodes relative to the highway zone at (100 km, 0)
W.hwzone, W.hwentry = 9001, 9002
W.objs[W.hwzone] = { class = "highway", name = "Local Highway", x = 100000, z = 0 }
W.objs[W.hwentry] = { class = "highwayentrygate", name = "Entry", x = 100000, z = 0 }
local HW_NODES = { { 0, 0, 1, 0, 0, 20000 }, { 60000, 30000, 0, 1, 20000, 0 } }   -- x, z, tx, tz, in, out
C.GetNumHighwaySplinePoints = function(hw) return n64(hw) == W.hwzone and #HW_NODES or 0 end
C.GetHighwaySplinePoints = function(buf, n, hw)
    for i = 1, math.min(n, #HW_NODES) do
        local d = HW_NODES[i]
        buf[i - 1].offset.x, buf[i - 1].offset.y, buf[i - 1].offset.z = d[1], 0, d[2]
        buf[i - 1].tangent.x, buf[i - 1].tangent.y, buf[i - 1].tangent.z = d[3], 0, d[4]
        buf[i - 1].inlength, buf[i - 1].outlength, buf[i - 1].weight = d[5], d[6], 1
    end
    return math.min(n, #HW_NODES)
end
C.GetNumAllFactionShips = function(f) return #W.playerships end
C.GetAllFactionShips = function(buf, n, f) for i = 0, n - 1 do buf[i] = W.playerships[i + 1] end; return n end
C.GetNumAllFactionStations = function(f) return #W.playerstations end
C.GetAllFactionStations = function(buf, n, f) for i = 0, n - 1 do buf[i] = W.playerstations[i + 1] end; return n end
C.GetNumOrders = function(id) return n64(id) % 3 end
C.GetOrders = function(buf, n, id)
    for i = 0, n - 1 do buf[i].orderdef = cs(i == 0 and "TradeRoutine" or "Wait"); buf[i].statename = cs("running") end
    return n
end
C.GetOrderQueueCurrentIdx = function(id) return 1 end
C.GetDefaultOrder = function(o, id) o.orderdef = cs("MiningRoutine"); o.statename = cs("default"); return true end
C.GetOrderDefinition = function(od, def) od.name = cs("Order " .. ffi.string(def)); return true end
C.GetNumStationModules = function() return 12 end
C.GetWorkForceInfo = function() error("mock: GetWorkForceInfo always fails (source must switch off)") end
C.GetNumTickerCache = function() return MOCK.nticker end
C.GetTickerCache = function(buf, len, start, cnt, cat)
    for i = 0, cnt - 1 do
        local k = start + i
        buf[i].id = 9000 + k; buf[i].time = k; buf[i].category = cs("general"); buf[i].title = cs("Ticker " .. k); buf[i].text = cs("")
    end
    return cnt
end
C.GetNumMessages = function(cat, unread) return unread and 1 or 3 end
C.GetMessages = function(buf, len, start, cnt, cat)
    for i = 0, cnt - 1 do
        buf[i].id = 7000 + start + i; buf[i].time = 10 + i; buf[i].category = cs(cat); buf[i].title = cs("Msg " .. i)
        buf[i].text = cs("text"); buf[i].source = cs("src"); buf[i].interaction = cs(""); buf[i].interactioncomponent = 0
        buf[i].isread = i > 0; buf[i].money = 0
    end
    return cnt
end
C.GetNumCurrentMissionOffers = function() return 14 end
C.GetCurrentMissionOffers = function(buf, n) for i = 0, n - 1 do buf[i] = 80000 + i end; return n end
C.GetActiveMissionID = function() return MOCK.am or 60001 end
-- v1.3 guidance: objective targets of a mission (MOCK.objtargets, index base MOCK.objbase, default 1-based like
-- GetMissionObjectiveStep3); out of range -> 0
MOCK.objbase = 1
C.GetMissionIDObjectiveTarget = function(mid, idx)
    count("GetMissionIDObjectiveTarget")
    local list = MOCK.objtargets or {}
    local i = tonumber(idx) - MOCK.objbase + 1
    if i < 1 or not list[i] then return 0 end
    return list[i]
end
C.GetUIRelationName = function(a, b) return ffi.new("RelationRangeInfo", { cs("Neutral"), cs("neutral") }) end
C.GetNumTransactionLog = function() return 850 end
C.GetTransactionLog = function(buf, n)
    for i = 0, n - 1 do
        buf[i].time = 4000 + i; buf[i].money = ((i % 2 == 0) and 1 or -1) * (1000 + i) * 100
        buf[i].eventtype = cs("trade"); buf[i].eventtypename = cs("Trade"); buf[i].partnername = cs("Own " .. (i % 10))
        buf[i].partneridcode = cs("ABC-" .. i % 10); buf[i].ware = cs("energycells"); buf[i].amount = 10 + i
    end
    return n
end
C.IsInfoUnlockedForPlayer = function(id) return (n64(id) % 11) ~= 0 end
C.IsKnownToPlayer = function(id) local o = O(id); return o ~= nil and o.known ~= false end
C.GetPlayerControlledShipID = function() return W.ship end
C.SetSofttarget = function(id, conn) MOCK.targets[#MOCK.targets + 1] = n64(id); MOCK.softtarget = n64(id); return true end
C.SetGuidance = function(id, off) MOCK.guidance[#MOCK.guidance + 1] = n64(id) end
C.EndGuidance = function() MOCK.guidance[#MOCK.guidance + 1] = 0 end
C.SetFocusMapComponent = function(holo, id, reset) MOCK.opened[#MOCK.opened + 1] = "focus:" .. n64(id) end
C.IsOrderSelectableFor = function() return true end
C.RemoveOrder = function(ship, i) MOCK.orders[#MOCK.orders + 1] = "remove:" .. i; return true end
C.ResetOrderLoop = function() end
C.CreateOrder = function(ship, def, d) MOCK.orders[#MOCK.orders + 1] = "create:" .. ffi.string(def); return 1 end
C.EnablePlannedDefaultOrder = function() return true end
__X4COMPANION_TEST_C = C

-------------------------------------------------------------------------------- Lua globals
function GetCurRealTime() return MOCK.now end
function DebugError(s) MOCK.debug[#MOCK.debug + 1] = tostring(s) end
function UIInfo(s) MOCK.info[#MOCK.info + 1] = "I " .. tostring(s) end
function UIWarning(s) MOCK.info[#MOCK.info + 1] = "W " .. tostring(s) end
function UIError(s) MOCK.info[#MOCK.info + 1] = "E " .. tostring(s) end
function SetScript(ev, fn) if ev == "onUpdate" then MOCK.onupdate = fn end end
function RegisterEvent(name, fn) MOCK.events[name] = fn end
function ConvertStringTo64Bit(s) return tonumber(s) end
function ConvertStringToLuaID(s) return setmetatable({ id = tonumber(s) }, { __tostring = function(t) return "ID: " .. t.id end }) end
function ConvertIDTo64Bit(v)
    if type(v) == "number" then return v end
    if type(v) == "table" then return v.id end
    return nil
end
local function idof(v) if type(v) == "table" then return v.id end return tonumber(v) end
function CanViewLiveData(id)
    local o = W.objs[idof(id)]
    if not o then return false end
    if o.live ~= nil then return o.live end
    return o.isinliveview ~= false
end
function IsValidComponent(id) return W.objs[idof(id)] ~= nil end
function GetPlayerMoney() return 12345678 end
function GetClusters(known) local out = {}; for _, c in ipairs(W.clusters) do out[#out + 1] = ConvertStringToLuaID(tostring(c)) end; return out end
function GetSectors(c) local out = {}; for _, s in ipairs(W.sectors[idof(c)] or {}) do out[#out + 1] = ConvertStringToLuaID(tostring(s)) end; return out end
local PROPS = { name = "name", idcode = "code", hullpercent = "hull", shieldpercent = "shield", owner = "owner", macro = "macro",
                primarypurpose = "purpose", isplayerowned = "isplayerowned", isknown = "isknown", isinliveview = "isinliveview",
                destination = "destination", isactive = "isactive", money = "money", assignedpilot = "assignedpilot",
                ownername = "owner" }
function GetComponentData(id, ...)
    count("GetComponentData")
    local o = W.objs[idof(id)]
    if not o then error("invalid component") end
    local out = {}
    local n = select("#", ...)
    for i = 1, n do
        local p = select(i, ...)
        local k = PROPS[p]
        local v = nil
        if k then v = o[k] end            -- keeps false (isknown = false is a real answer of the game)
        if p == "uirelation" then v = (o.owner == "xenon") and -30 or 5 end
        if p == "isenemy" then v = o.owner == "xenon" end
        if p == "ishostile" then v = o.owner == "xenon" end
        if p == "iswreck" then v = false end
        if p == "isactive" then v = true end
        if p == "isradarvisible" then v = true end
        if p == "cargo" then v = { energycells = 120 + (idof(id) % 50), ore = 7 } end
        if p == "fleetname" then v = (idof(id) % 7 == 0) and "Alpha" or "" end
        if p == "icon" then
            if o.class == "navbeacon" then error("mock: icon not supported for this class") end
            if o.class:sub(1, 5) == "ship_" then v = o.class .. "_trade_01"
            elseif o.class == "station" then v = "mapob_tradestation"
            elseif o.class == "gate" then v = "mapob_jumpgate"
            elseif o.class == "satellite" then v = "mapob_satellite_01" end
        end
        if p == "ismissiontarget" then v = idof(id) % 13 == 0 end
        if p == "maxradarrange" then v = (o.class == "satellite") and 30000 or 40000 end
        if p == "isdocked" or p == "isdocking" then v = false end
        if p == "destination" and o.destination then v = ConvertStringToLuaID(tostring(o.destination)) end
        out[i] = v
    end
    return unpack(out, 1, n)
end
function GetContainedObjectsByOwner(owner, space)
    if owner == "badfaction" then error("mock: owner lookup failure") end
    local out = {}
    local sid = idof(space)
    for _, id in ipairs(W.byowner[owner] or {}) do
        if (sid == nil) or W.objs[id].sector == sid then out[#out + 1] = ConvertStringToLuaID(tostring(id)) end
    end
    return out
end
function GetCommander(id) local n = idof(id); if n % 4 == 0 then return ConvertStringToLuaID(tostring(W.playerships[1])) end return nil end
function GetLibrary(lib)
    local out = {}
    for _, f in ipairs(FACTIONS) do out[#out + 1] = { id = f, name = f:upper() } end
    return out
end
function GetFactionData(f, ...)
    if f == "badfaction" then error("mock: faction data failure") end
    return f:sub(1, 3):upper(), f == "xenon", f == "xenon", false, { r = 10, g = 20, b = 30, a = 100 }
end
function GetUIRelation(f) return f == "xenon" and -30 or 7 end
function GetOwnLicences(f) return { { type = "generaluseequipment", name = "General", price = 0, minrelation = 0 }, { type = "capitalship", name = "Capital", price = 1000, minrelation = 20 } } end
function HasLicence(p, t, f) return t == "generaluseequipment" end
MOCK.logs = { general = {}, missions = {}, news = {}, diplomacy = {}, alerts = {}, upkeep = {}, tips = {} }
for cat, list in pairs(MOCK.logs) do
    for i = 1, 55 do list[i] = { time = i * 10, title = cat .. " entry " .. i, text = (i == 3) and "bad \255\254 \27[i]x" or "", entityname = "", factionname = "",
                                 money = 0, bonus = 0, interaction = (cat == "alerts") and "showonmap" or "", interactioncomponent = (cat == "alerts") and ConvertStringToLuaID(tostring(W.playerships[1])) or nil } end
end
function GetNumLogbook(cat) return #(MOCK.logs[cat] or {}) end
function GetLogbook(start, n, cat)
    local out = {}
    local list = MOCK.logs[cat] or {}
    for i = start, start + n - 1 do if list[i] then out[#out + 1] = list[i] end end
    return out
end
MOCK.nticker = 40
function GetNumMissions() return 6 end
function GetActiveMission() return 1 end
function GetMissionDetails(i)
    return ConvertStringToLuaID(tostring(60000 + i)), "Mission " .. i, "desc", 2, "", (i == 1 and MOCK.mt1) or "fight", "", "Fight", "argon", 50000 * i, "",
           nil, nil, nil, nil, nil, 600, nil, true, (i == 1 and MOCK.dg1) or false, ConvertStringToLuaID(tostring(W.playerships[2])), 0, true, nil
end
function GetMissionObjective(i) return (i == 1 and MOCK.ob1) or ("Objective " .. i), 300, "Progress", 1, 5 end
function GetMissionOfferDetails(id)
    return "Offer " .. idof(id), "desc", 1, "", "trade", "", "Trade", "teladi", 12000, "", nil, nil, nil, nil, nil, 0, 900, nil, nil, nil, nil,
           ConvertStringToLuaID(tostring(W.playerships[3]))
end
function GetWareData(w, p) return "Ware " .. w end
MOCK.bb = {}
function GetNPCBlackboard(id, var) return (MOCK.bb[idof(id)] or {})[var] end
function SetNPCBlackboard(id, var, val) MOCK.bb[idof(id)] = MOCK.bb[idof(id)] or {}; MOCK.bb[idof(id)][var] = val end
function AddUITriggeredEvent(screen, control, value)
    MOCK.raise[#MOCK.raise + 1] = screen .. "/" .. control
    if screen == "x4companion" and control == "guidance" and MOCK.md_guidance ~= false and MOCK.events["x4companion.guidance"] then
        -- what md\x4_companion_guidance.xml does: the expanded path (MOCK.gdpath, ids), [known, n], the
        -- waypoint, ONE event (here also a duplicate delivery, which must be harmless)
        MOCK.gd_req = (MOCK.gd_req or 0) + 1
        MOCK.gd_value = value and idof(value) or 0
        local pl = {}
        for _, id in ipairs(MOCK.gdpath or {}) do pl[#pl + 1] = ConvertStringToLuaID(tostring(id)) end
        SetNPCBlackboard(W.player, "$x4companion_gdpath", pl)
        SetNPCBlackboard(W.player, "$x4companion_gdinfo", { MOCK.gdknown or 1, #pl })
        SetNPCBlackboard(W.player, "$x4companion_gdwp", MOCK.gdwp and ConvertStringToLuaID(tostring(MOCK.gdwp)) or nil)
        MOCK.events["x4companion.guidance"]("x4companion.guidance", #pl)
        MOCK.events["x4companion.guidance"]("x4companion.guidance", #pl)
    end
    if screen == "x4companion" and control == "gates" and MOCK.md_gates ~= false then
        -- what md\x4_companion_gates.xml does: both lists on player.entity's blackboard, ONE event
        local gl = {}
        for _, g in ipairs(W.gates) do gl[#gl + 1] = ConvertStringToLuaID(tostring(g)) end
        SetNPCBlackboard(W.player, "$x4companion_gates", gl)
        SetNPCBlackboard(W.player, "$x4companion_hwgates", { ConvertStringToLuaID(tostring(W.gates[3])) })
        MOCK.events["x4companion.gates"]("x4companion.gates", #W.gates)
        -- a duplicate delivery in the same frame must not wipe the list
        MOCK.events["x4companion.gates"]("x4companion.gates", #W.gates)
    end
    if screen == "x4companion" and control == "sectorinfo" and MOCK.events["x4companion.sectorinfo"] then
        -- what md\x4_companion_sector.xml does: [sector, coresize, coreposition.x, .z, iscontested]
        local sec = W.objs[W.player].sector
        SetNPCBlackboard(W.player, "$x4companion_sectorinfo", { ConvertStringToLuaID(tostring(sec)), 400000, 10000, -5000, sec == 520 })
        SetNPCBlackboard(W.player, "$x4companion_highways", { { ConvertStringToLuaID(tostring(W.hwzone)), ConvertStringToLuaID(tostring(W.hwentry)) } })
        MOCK.events["x4companion.sectorinfo"]("x4companion.sectorinfo", nil)
        MOCK.events["x4companion.sectorinfo"]("x4companion.sectorinfo", nil)   -- duplicate delivery: harmless
    end
end
-- the game map's colours (helper.lua:13070 order); mock values only
function GetHoloMapColors()
    local out = {}
    for i = 1, 22 do out[i] = { r = i * 10, g = 200 - i, b = 100 + i, a = 100 } end
    return unpack(out)
end
Color = { text_normal = { r = 255, g = 255, b = 255, a = 100 }, text_inactive = { r = 128, g = 128, b = 128, a = 100 } }
MOCK.guidancetarget = nil
function GetActiveGuidanceMissionComponent() return MOCK.guidancetarget and ConvertStringToLuaID(tostring(MOCK.guidancetarget)) or nil end
function GetAutoPilotTarget() return nil end
function GetOrderParams(ship, idx)
    if idx == 1 then return { { name = "destination", type = "position", value = { ConvertStringToLuaID(tostring(W.sector)), { 1000, 0, 2000 } } } } end
    if idx == 2 then return { { name = "target", type = "object", value = ConvertStringToLuaID(tostring(MOCK.secretship)) } } end
    return {}
end
function CreateOrder(ship, def, params, ...) MOCK.orders[#MOCK.orders + 1] = "lua:" .. def .. ":" .. tostring(idof(params.destination[1])) end
MOCK.mapmenu = { name = "MapMenu", shown = false, holomap = 0 }
Menus = { MOCK.mapmenu, { name = "PlayerInfoMenu", shown = false } }
function OpenMenu(name, param) MOCK.opened[#MOCK.opened + 1] = name .. ":" .. tostring(idof(param[4])) end
HotkeyApi = { registered = {} }
function HotkeyApi.RegisterAction(req) HotkeyApi.registered[#HotkeyApi.registered + 1] = req end

-------------------------------------------------------------------------------- SN modules
local Pipes = { winpipe_loaded = true, reads = {} }
function Pipes.Schedule_Write(name, cb, msg)
    if MOCK.write_fail then cb("ERROR"); return end
    MOCK.out[#MOCK.out + 1] = msg
    cb("SUCCESS")
end
function Pipes.Schedule_Read(name, cb, cont) Pipes.reads[#Pipes.reads + 1] = cb; MOCK.readcb = cb end
local Time = {}
function Time.Register_NewFrame_Callback(fn) MOCK.snframe = fn end
package.preload["extensions.sn_mod_support_apis.ui.named_pipes.Pipes"] = function() return Pipes end
package.preload["extensions.sn_mod_support_apis.ui.time.Interface"] = function() return Time end

MOCK.W = W
MOCK.frame = function(dt)
    MOCK.now = MOCK.now + (dt or 1 / 60)
    if MOCK.onupdate then MOCK.onupdate() end
    if MOCK.snframe then MOCK.snframe() end    -- second frame source in the same frame: must be a no-op
end
