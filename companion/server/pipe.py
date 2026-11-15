"""Duplex Windows named-pipe server for the SirNukes (sn_mod_support_apis 1.95) pipe client.

Protocol facts (verified in the installed SN 1.95, ext_01.cat; v0 confirmed them in the game):
  - X4 is the client; the external process serves the pipe        (named_pipes/interface.lua:8-9)
  - client path = "\\\\.\\pipe\\" .. pipe_name                    (named_pipes/pipes.lua:49, 354)
  - reads are non-blocking on the client (ERROR_NO_DATA on an empty pipe, pipes.lua:697-705),
    one file:write() is one message (pipes.lua:773)
  - a write error closes the client pipe (pipes.lua:775-802); it reopens on the next request.
    Quirk (pipes.lua:814-840): a retried write that succeeded is still reported as an error and
    the pipe is closed - so the server may see a message followed by a disconnect.
  - on UI reload / GC the client writes the literal "garbage_collected" (pipes.lua:267)

v1 change vs v0: the server also WRITES (commands for the game) on the same connection. With a
synchronous handle a pending ReadFile would block every WriteFile, so each instance is opened
with FILE_FLAG_OVERLAPPED and one worker thread per connection waits on "read completed" and
"command queued" at the same time. Message mode, 1 MB quota, local clients only, one instance
always waiting so a restarted game connects at once.
"""
from __future__ import annotations

import collections
import logging
import threading
import time
from typing import Callable

import pywintypes
import win32event
import win32file
import win32pipe
import winerror

log = logging.getLogger("x4companion.pipe")

PIPE_REJECT_REMOTE_CLIENTS = 0x00000008
FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000
BUFFER_SIZE = 1 << 20
READ_CHUNK = 1 << 16
GC_NOTICE = "garbage_collected"
WAIT_MS = 250


class PipeServerError(RuntimeError):
    pass


class _Conn:
    def __init__(self, cid: int, handle):
        self.cid = cid
        self.handle = handle
        self.queue: collections.deque[bytes] = collections.deque()
        self.wake = win32event.CreateEvent(None, True, False, None)
        self.alive = True
        self.connected_at = time.monotonic()


class PipeServer:
    """on_message(line, cid), on_status(event, cid) are called from worker threads."""

    def __init__(self, name: str, on_message: Callable[[str, int], None],
                 on_status: Callable[[str, int], None]):
        self.name = name
        self.path = "\\\\.\\pipe\\" + name
        self.on_message = on_message
        self.on_status = on_status
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._seq = 0
        self.conns: dict[int, _Conn] = {}
        self._first = None
        self._accept_thread: threading.Thread | None = None

    # ------------------------------------------------------------------ public
    def start(self) -> None:
        try:
            self._first = self._create(first=True)
        except pywintypes.error as e:
            if e.winerror in (winerror.ERROR_ACCESS_DENIED, winerror.ERROR_PIPE_BUSY):
                raise PipeServerError(f"{self.path} is already served by another process "
                                      f"(is a second x4companion server running?)") from e
            raise
        self._accept_thread = threading.Thread(target=self._accept_loop, name="pipe-accept", daemon=True)
        self._accept_thread.start()
        log.info("pipe server listening on %s", self.path)

    def stop(self) -> None:
        self._stop.set()
        with self._lock:
            conns = list(self.conns.values())
        for c in conns:
            win32event.SetEvent(c.wake)
        if self._accept_thread:
            self._accept_thread.join(timeout=3)

    def newest(self) -> int | None:
        with self._lock:
            live = [c for c in self.conns.values() if c.alive]
        if not live:
            return None
        return max(live, key=lambda c: c.connected_at).cid

    def send(self, data: bytes, cid: int | None = None) -> bool:
        """Queue one message for the game (newest connection by default)."""
        if cid is None:
            cid = self.newest()
        with self._lock:
            c = self.conns.get(cid) if cid is not None else None
        if c is None or not c.alive:
            return False
        c.queue.append(data)
        win32event.SetEvent(c.wake)
        return True

    # ------------------------------------------------------------------ internals
    def _create(self, first: bool):
        open_mode = (win32pipe.PIPE_ACCESS_DUPLEX | win32file.FILE_FLAG_OVERLAPPED
                     | (FILE_FLAG_FIRST_PIPE_INSTANCE if first else 0))
        pipe_mode = (win32pipe.PIPE_TYPE_MESSAGE | win32pipe.PIPE_READMODE_MESSAGE
                     | win32pipe.PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS)
        return win32pipe.CreateNamedPipe(self.path, open_mode, pipe_mode,
                                         win32pipe.PIPE_UNLIMITED_INSTANCES,
                                         BUFFER_SIZE, BUFFER_SIZE, 0, None)

    def _new_instance(self):
        while not self._stop.is_set():
            try:
                return self._create(first=False)
            except pywintypes.error as e:
                log.error("CreateNamedPipe failed: %s; retrying in 1 s", e)
                time.sleep(1)
        return None

    def _accept_loop(self) -> None:
        handle = self._first
        ov = pywintypes.OVERLAPPED()
        ov.hEvent = win32event.CreateEvent(None, True, False, None)
        while not self._stop.is_set() and handle is not None:
            win32event.ResetEvent(ov.hEvent)
            try:
                rc = win32pipe.ConnectNamedPipe(handle, ov)
            except pywintypes.error as e:
                log.warning("ConnectNamedPipe failed: %s; recreating instance", e)
                self._close(handle)
                time.sleep(0.2)
                handle = self._new_instance()
                continue
            connected = rc == winerror.ERROR_PIPE_CONNECTED
            while not connected and not self._stop.is_set():
                r = win32event.WaitForSingleObject(ov.hEvent, WAIT_MS)
                if r == win32event.WAIT_OBJECT_0:
                    try:
                        win32file.GetOverlappedResult(handle, ov, False)
                        connected = True
                    except pywintypes.error as e:
                        log.warning("pipe connect completed with error %s", e)
                        break
            if self._stop.is_set():
                self._close(handle)
                break
            if not connected:
                self._close(handle)
                handle = self._new_instance()
                continue
            with self._lock:
                self._seq += 1
                cid = self._seq
                conn = _Conn(cid, handle)
                self.conns[cid] = conn
            threading.Thread(target=self._worker, args=(conn,), name=f"pipe-conn-{cid}", daemon=True).start()
            handle = self._new_instance()
        win32file.CloseHandle(ov.hEvent)

    def _worker(self, c: _Conn) -> None:
        self._status("connected", c.cid)
        reason = "closed by client"
        rov = pywintypes.OVERLAPPED()
        rov.hEvent = win32event.CreateEvent(None, True, False, None)
        wov = pywintypes.OVERLAPPED()
        wov.hEvent = win32event.CreateEvent(None, True, False, None)
        buf = win32file.AllocateReadBuffer(READ_CHUNK)
        pending = b""
        try:
            win32file.ReadFile(c.handle, buf, rov)
            while not self._stop.is_set():
                r = win32event.WaitForMultipleObjects([rov.hEvent, c.wake], False, WAIT_MS)
                if r == win32event.WAIT_OBJECT_0:
                    more = False
                    try:
                        n = win32file.GetOverlappedResult(c.handle, rov, False)
                    except pywintypes.error as e:
                        if e.winerror == winerror.ERROR_MORE_DATA:
                            n = rov.InternalHigh or READ_CHUNK
                            more = True
                        else:
                            raise
                    pending += bytes(buf[:n])
                    if not more:
                        raw, pending = pending, b""
                        if not self._deliver(raw, c.cid):
                            reason = "client sent garbage_collected (UI reload)"
                            break
                    win32event.ResetEvent(rov.hEvent)
                    win32file.ReadFile(c.handle, buf, rov)
                elif r == win32event.WAIT_OBJECT_0 + 1:
                    win32event.ResetEvent(c.wake)
                    while c.queue:
                        data = c.queue.popleft()
                        win32event.ResetEvent(wov.hEvent)
                        win32file.WriteFile(c.handle, data, wov)
                        if win32event.WaitForSingleObject(wov.hEvent, 2000) != win32event.WAIT_OBJECT_0:
                            raise pywintypes.error(winerror.ERROR_TIMEOUT, "WriteFile", "write timed out")
                        win32file.GetOverlappedResult(c.handle, wov, False)
        except pywintypes.error as e:
            if e.winerror not in (winerror.ERROR_BROKEN_PIPE, winerror.ERROR_PIPE_NOT_CONNECTED,
                                  winerror.ERROR_NO_DATA, winerror.ERROR_OPERATION_ABORTED):
                reason = f"pipe error {e.winerror}: {e.strerror}"
        finally:
            c.alive = False
            try:
                win32file.CancelIo(c.handle)
            except pywintypes.error:
                pass
            try:
                win32pipe.DisconnectNamedPipe(c.handle)
            except pywintypes.error:
                pass
            self._close(c.handle)
            for h in (rov.hEvent, wov.hEvent, c.wake):
                try:
                    win32file.CloseHandle(h)
                except pywintypes.error:
                    pass
            with self._lock:
                self.conns.pop(c.cid, None)
            self._status("disconnected:" + reason, c.cid)

    def _deliver(self, raw: bytes, cid: int) -> bool:
        text = raw.decode("utf-8", errors="replace")     # a bad byte never drops the connection
        if text.strip() == GC_NOTICE:
            return False
        for line in text.splitlines():
            if line.strip():
                try:
                    self.on_message(line, cid)
                except Exception:
                    log.exception("on_message failed")
        return True

    def _status(self, event: str, cid: int) -> None:
        try:
            self.on_status(event, cid)
        except Exception:
            log.exception("on_status failed")

    @staticmethod
    def _close(handle) -> None:
        if handle is None:
            return
        try:
            win32file.CloseHandle(handle)
        except pywintypes.error:
            pass
