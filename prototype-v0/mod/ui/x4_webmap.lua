--[[
x4_webmap.lua - X4 WebMap bridge (day-one "proof of life").

Every ~0.25 s it collects:
  - the player's current sector (id, name),
  - the player position in that sector (x, y, z, yaw),
  - the player-owned ships in that sector (id, name, idcode, class, x, z, yaw),
encodes one JSON line and writes it to the named pipe \\.\pipe\x4webmap through the
SirNukes Mod Support APIs (sn_mod_support_apis 1.95, Pipes.Schedule_Write).
The local server tools\x4webmap\server.py is the pipe server; X4 is only a client.

Safety: every game/API call runs inside pcall. A failure only skips one snapshot and is
logged to debug.txt at most once per 10 s per kind; it can never raise into the game UI.

Every API used below was checked against the 9.00 vanilla UI Lua (ui\ from 08.cat, the
only catalog with UI Lua; hashes match the installed 08.cat) or the installed SN 1.95
(ext_01.cat, hashes match). File:line = where the same call is used/declared there:

  ffi C declarations (copied verbatim from vanilla cdefs):
    UniverseID GetPlayerID(void)                         menu_help.lua:24
    UniverseID GetPlayerOccupiedShipID(void)             menu_crafting.lua:25
    UniverseID GetContextByClass(UniverseID, const char*, bool)  menu_docked.lua:78
    UIPosRot   GetObjectPositionInSector(UniverseID)     helper.lua:366 (struct helper.lua:154-161)
    const char* GetComponentName(UniverseID)             helper.lua:315
    const char* GetComponentClass(UniverseID)            menu_map.lua:587
    const char* GetObjectIDCode(UniverseID)              helper.lua:365 (declared, not needed)
    bool IsComponentClass(UniverseID, const char*)       menu_map.lua:839
    bool IsGamePaused(void)                              helptext.lua:9
  usage patterns:
    C.GetContextByClass(C.GetPlayerID(), "sector", false)          menu_map.lua:5561
    C.GetContextByClass(C.GetPlayerID(), "container", false)       menu_docked.lua:301
    ConvertStringTo64Bit(tostring(C.GetPlayerOccupiedShipID()))    chatwindow.lua:487
    GetContainedObjectsByOwner("player")                           menu_map.lua:8225
    GetContainedObjectsByOwner("player", ConvertStringToLuaID(tostring(x)))  menu_platformundock.lua:121
    ConvertIDTo64Bit(object)                                       menu_map.lua:8229
    GetComponentData(object, "name", ..., "idcode", ...)           menu_map.lua:8230
    C.IsComponentClass(object64, "controllable")                   menu_map.lua:4839
    ffi.string(C.GetComponentClass(id))                            menu_map.lua:13191
    ffi.string(C.GetComponentName(id))                             menu_map.lua:2274
    C.GetObjectPositionInSector(component)                         menu_interactmenu.lua:1069
    GetCurRealTime()                                               menu_ship_configuration.lua:9924
    SetScript("onUpdate", fn)                                      ego_debug\debug.lua:14
    RegisterEvent("name", fn)                                      menu_map.lua:1942
    DebugError(text)                                               menu_map.lua:2274
  SN 1.95:
    require("extensions.sn_mod_support_apis.ui.named_pipes.Pipes")  pipes.lua:857 (registration)
    Pipes.Schedule_Write(pipe_name, callback, message)               pipes.lua:161
      callback gets "SUCCESS" or "ERROR"                             pipes.lua:629 / 456
      pipe path = "\\.\pipe\" .. pipe_name                           pipes.lua:49, 354
    Pipes.winpipe_loaded                                             pipes.lua:46
    require("extensions.sn_mod_support_apis.ui.time.Interface")      time\interface.lua:547
      .Register_NewFrame_Callback(fn)  (onUpdate + SN MD 1 ms heartbeat) time\interface.lua:516

Tick sources (the open risk: does the UI update loop keep running when X4 loses focus?):
  1. SetScript("onUpdate")           - own per-frame hook.
  2. SN Time Register_NewFrame_Callback - SN merges onUpdate with its own MD heartbeat
                                          (md\time_api.xml cue MD_New_Frame, 1 ms).
  3. optional md\x4_webmap_tick.xml   - MD cue every 250 ms -> raise_lua_event
                                          "x4webmap.mdTick". Sends only if no frame-driven
                                          snapshot went out for 2 MD ticks (~0.5 s), and
                                          does not depend on GetCurRealTime (which SN notes
                                          does not count tabbed-out time).
  Each snapshot carries "src" ("frame" or "md") so the browser shows which source is alive.
]]

local ffi = require("ffi")
local C = ffi.C

-- Each declaration separately and guarded: vanilla files re-declare these too, and a
-- failing redeclaration must not stop the others (or the file).
local function cdef(decl)
    pcall(ffi.cdef, decl)
end
cdef("typedef uint64_t UniverseID;")
cdef([[typedef struct {
    float x;
    float y;
    float z;
    float yaw;
    float pitch;
    float roll;
} UIPosRot;]])
cdef("UniverseID GetPlayerID(void);")
cdef("UniverseID GetPlayerOccupiedShipID(void);")
cdef("UniverseID GetContextByClass(UniverseID componentid, const char* classname, bool includeself);")
cdef("UIPosRot GetObjectPositionInSector(UniverseID objectid);")
cdef("const char* GetComponentName(UniverseID componentid);")
cdef("const char* GetComponentClass(UniverseID componentid);")
cdef("bool IsComponentClass(UniverseID componentid, const char* classname);")
cdef("bool IsGamePaused(void);")

-------------------------------------------------------------------------------
-- Config / state

local CFG = {
    pipe_name   = "x4webmap",  -- -> \\.\pipe\x4webmap
    interval    = 0.25,        -- seconds between snapshots (~4 Hz)
    max_ships   = 400,         -- hard cap per snapshot
    max_bytes   = 60000,       -- keep each pipe message under the 64 KB SN/Windows buffer
    retry_ticks = 8,           -- after a failed write, skip this many eligible ticks (~2 s)
    busy_reset  = 5.0,         -- a write callback missing this long -> assume lost
    log_every   = 10.0,        -- debug.txt rate limit per message kind (seconds)
}

local W = {
    init_done     = false,
    pipes         = nil,       -- SN Pipes module once required
    pipes_tried   = -1e9,
    last_send     = -1e9,
    md_since_frame = 0,      -- MD ticks since the last frame-driven send
    busy          = false,
    busy_since    = 0,
    skip_ticks    = 0,
    connected     = false,
    seq           = 0,
    n_frame       = 0,
    n_md          = 0,
    space_mode    = "?",       -- "sector" or "all" (which GetContainedObjectsByOwner form worked)
    last_log      = {},
}

local function realtime()
    local ok, t = pcall(GetCurRealTime)
    if ok and type(t) == "number" then return t end
    return 0
end

local function log(kind, msg)
    local now = realtime()
    local last = W.last_log[kind]
    if last and (now - last) < CFG.log_every and now >= last then return end
    W.last_log[kind] = now
    pcall(DebugError, "x4_webmap: " .. tostring(msg))
end

-------------------------------------------------------------------------------
-- Helpers

-- uint64 cdata / LuaID / number -> plain number (vanilla pattern: ConvertStringTo64Bit(tostring(x)))
local function to64(v)
    if v == nil then return 0 end
    if type(v) == "number" then return v end
    local ok, n = pcall(ConvertStringTo64Bit, tostring(v))
    if ok and type(n) == "number" then return n end
    return 0
end

-- Stable decimal id string for JSON (avoids %.14g rounding of big numbers).
local function idstr(v)
    if type(v) == "number" then return string.format("%.0f", v) end
    local s = tostring(v)
    return string.match(s, "%d+") or s
end

local function num(v, fmt)
    v = tonumber(v)
    if v == nil or v ~= v or v == math.huge or v == -math.huge then return "0" end
    return string.format(fmt or "%.1f", v)
end

local escapes = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
local function str(s)
    if s == nil then return "null" end
    s = tostring(s)
    -- drop X4 text escapes (\27[icon], \27#AARRGGBB#, \27X ...) so names stay readable
    s = string.gsub(s, "\27%b[]", "")
    s = string.gsub(s, "\27#%x+#", "")
    s = string.gsub(s, "\27.", "")
    s = string.gsub(s, '[%c"\\]', function(c)
        return escapes[c] or string.format("\\u%04x", string.byte(c))
    end)
    return '"' .. s .. '"'
end

local function cstr(p)
    if p == nil then return nil end
    local ok, s = pcall(ffi.string, p)
    if ok then return s end
    return nil
end

-------------------------------------------------------------------------------
-- Snapshot

local function getOwnShips(sector64, playership)
    local list
    -- Preferred: only objects in the player's sector (space form as in menu_platformundock.lua:121).
    local ok, res = pcall(GetContainedObjectsByOwner, "player", ConvertStringToLuaID(tostring(sector64)))
    if ok and type(res) == "table" then
        list = res
        W.space_mode = "sector"
    else
        -- Fallback: every player object (menu_map.lua:8225), filtered by sector below.
        local ok2, res2 = pcall(GetContainedObjectsByOwner, "player")
        if ok2 and type(res2) == "table" then
            list = res2
            W.space_mode = "all"
        else
            log("owner", "GetContainedObjectsByOwner failed: " .. tostring(res) .. " / " .. tostring(res2))
            return {}, false
        end
    end

    local parts, bytes, truncated = {}, 0, false
    for _, obj in ipairs(list) do
        if #parts >= CFG.max_ships or bytes > (CFG.max_bytes - 4000) then
            truncated = true
            break
        end
        local okS, entry = pcall(function()
            local o64 = to64(ConvertIDTo64Bit(obj))
            if o64 == 0 or not C.IsComponentClass(o64, "ship") then return nil end
            -- re-check the sector for both forms of the query
            if to64(C.GetContextByClass(o64, "sector", false)) ~= sector64 then return nil end
            local p = C.GetObjectPositionInSector(o64)
            local name, idcode = GetComponentData(obj, "name", "idcode")
            return '{"id":' .. str(idstr(o64))
                .. ',"name":' .. str(name)
                .. ',"code":' .. str(idcode)
                .. ',"class":' .. str(cstr(C.GetComponentClass(o64)))
                .. ',"x":' .. num(p.x) .. ',"y":' .. num(p.y) .. ',"z":' .. num(p.z)
                .. ',"yaw":' .. num(p.yaw, "%.4f")
                .. ',"player":' .. ((o64 == playership) and "true" or "false")
                .. '}'
        end)
        if okS then
            if entry then
                parts[#parts + 1] = entry
                bytes = bytes + #entry + 1
            end
        else
            log("ship", "ship entry failed: " .. tostring(entry))
        end
    end
    return parts, truncated
end

local function buildSnapshot(now, src)
    local playerid = to64(C.GetPlayerID())
    if playerid == 0 then return nil end           -- main menu / still loading

    local sector64 = to64(C.GetContextByClass(playerid, "sector", false))
    local playership = to64(C.GetPlayerOccupiedShipID())

    local sectorjson = "null"
    local playerjson = "null"
    local shipsjson = ""
    local truncated = false

    if sector64 ~= 0 then
        sectorjson = '{"id":' .. str(idstr(sector64)) .. ',"name":' .. str(cstr(C.GetComponentName(sector64))) .. '}'

        -- player reference object: occupied ship > container (station/ship walked in) > entity
        local obj, mode = playership, "ship"
        if obj == 0 then
            obj, mode = to64(C.GetContextByClass(playerid, "container", false)), "container"
            if obj == 0 then obj, mode = playerid, "entity" end
        end
        local okP, pj = pcall(function()
            local p = C.GetObjectPositionInSector(obj)
            return '{"id":' .. str(idstr(obj))
                .. ',"name":' .. str(cstr(C.GetComponentName(obj)))
                .. ',"mode":' .. str(mode)
                .. ',"x":' .. num(p.x) .. ',"y":' .. num(p.y) .. ',"z":' .. num(p.z)
                .. ',"yaw":' .. num(p.yaw, "%.4f") .. '}'
        end)
        if okP then playerjson = pj else log("player", "player position failed: " .. tostring(pj)) end

        local parts
        parts, truncated = getOwnShips(sector64, playership)
        shipsjson = table.concat(parts, ",")
    end

    local okPause, paused = pcall(function() return C.IsGamePaused() end)

    W.seq = W.seq + 1
    return '{"v":1,"type":"snapshot","seq":' .. W.seq
        .. ',"t":' .. num(now, "%.3f")
        .. ',"src":' .. str(src)
        .. ',"nframe":' .. W.n_frame .. ',"nmd":' .. W.n_md
        .. ',"paused":' .. ((okPause and paused) and "true" or "false")
        .. ',"space":' .. str(W.space_mode)
        .. ',"sector":' .. sectorjson
        .. ',"player":' .. playerjson
        .. ',"ships":[' .. shipsjson .. ']'
        .. ',"truncated":' .. (truncated and "true" or "false")
        .. '}\n'
end

-------------------------------------------------------------------------------
-- Pipe

local function getPipes()
    if W.pipes then return W.pipes end
    local now = realtime()
    if (now - W.pipes_tried) < 5 and now >= W.pipes_tried then return nil end
    W.pipes_tried = now
    local ok, P = pcall(require, "extensions.sn_mod_support_apis.ui.named_pipes.Pipes")
    if ok and type(P) == "table" and type(P.Schedule_Write) == "function" then
        W.pipes = P
        if P.winpipe_loaded == false then
            log("winpipe", "SN winpipe dll not loaded (Protected UI Mode on?) - pipe will stay disconnected")
        end
        return P
    end
    log("require", "SN Pipes API not available: " .. tostring(P))
    return nil
end

local function onWriteDone(result)
    W.busy = false
    if result == "SUCCESS" then
        if not W.connected then
            W.connected = true
            log("conn", "pipe \\\\.\\pipe\\" .. CFG.pipe_name .. " connected")
        end
    else
        if W.connected then
            log("conn", "pipe write failed (server stopped?) - retrying every ~2 s")
        end
        W.connected = false
        W.skip_ticks = CFG.retry_ticks
    end
end

local function send(msg)
    local P = getPipes()
    if not P then return end
    W.busy = true
    W.busy_since = realtime()
    -- Schedule_Write normally completes (and calls back) synchronously: pipes.lua:182
    local ok, err = pcall(P.Schedule_Write, CFG.pipe_name, onWriteDone, msg)
    if not ok then
        W.busy = false
        W.skip_ticks = CFG.retry_ticks
        log("write", "Schedule_Write raised: " .. tostring(err))
    end
end

-------------------------------------------------------------------------------
-- Tick

local function tick(src)
    local now = realtime()
    if src == "md" then
        -- MD fallback: only when the frame sources produced nothing for 2 MD ticks (~0.5 s).
        W.md_since_frame = W.md_since_frame + 1
        if W.md_since_frame < 2 then return end
    else
        if (now - W.last_send) < CFG.interval and now >= W.last_send then return end
    end

    if W.busy then
        if (now - W.busy_since) > CFG.busy_reset or now < W.busy_since then
            W.busy = false
        else
            return
        end
    end

    W.last_send = now
    if src ~= "md" then W.md_since_frame = 0 end

    if W.skip_ticks > 0 then
        W.skip_ticks = W.skip_ticks - 1
        return
    end

    if src == "md" then W.n_md = W.n_md + 1 else W.n_frame = W.n_frame + 1 end

    local ok, msg = pcall(buildSnapshot, now, src)
    if not ok then
        log("collect", "snapshot failed: " .. tostring(msg))
        return
    end
    if msg then send(msg) end
end

local function onFrame()
    local ok, err = pcall(tick, "frame")
    if not ok then log("tick", "tick failed: " .. tostring(err)) end
end

local function onMdTick()
    local ok, err = pcall(tick, "md")
    if not ok then log("tick", "md tick failed: " .. tostring(err)) end
end

-------------------------------------------------------------------------------
-- Init (the game loads ui.xml Lua but does not call any init for us -> call it here)

local function init()
    if W.init_done then return end
    W.init_done = true

    local ok1, e1 = pcall(SetScript, "onUpdate", onFrame)
    if not ok1 then log("init1", "SetScript onUpdate failed: " .. tostring(e1)) end

    local ok2, T = pcall(require, "extensions.sn_mod_support_apis.ui.time.Interface")
    if ok2 and type(T) == "table" and type(T.Register_NewFrame_Callback) == "function" then
        pcall(T.Register_NewFrame_Callback, onFrame)
    else
        log("init2", "SN Time API not available: " .. tostring(T))
    end

    -- Listener for the optional md\x4_webmap_tick.xml (harmless if that file is absent).
    local ok3, e3 = pcall(RegisterEvent, "x4webmap.mdTick", onMdTick)
    if not ok3 then log("init3", "RegisterEvent failed: " .. tostring(e3)) end
end

local okInit, errInit = pcall(init)
if not okInit then pcall(DebugError, "x4_webmap: init failed: " .. tostring(errInit)) end
