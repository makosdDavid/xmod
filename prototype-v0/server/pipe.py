"""Windows named-pipe server for the SirNukes (sn_mod_support_apis 1.95) pipe client.

Protocol facts this mirrors (verified in the installed SN 1.95, ext_01.cat):
  - X4 is the client; the external process serves the pipe   (named_pipes/interface.lua:8-9)
  - client path = "\\\\.\\pipe\\" .. pipe_name              (named_pipes/pipes.lua:49, 354)
  - the winpipe dll opens it with CreateFileA and sets the handle state with
    SetNamedPipeHandleState (dll import table); reads are non-blocking (ERROR_NO_DATA on an
    empty pipe, pipes.lua:697-705) and each file:write() is one message (pipes.lua:773).
  - a write that does not fit the buffer or hits a broken pipe is treated as a hard error and
    the client closes the pipe (pipes.lua:775-802), then reopens on the next request.
  - on UI reload / GC the client writes the literal "garbage_collected" instead of closing
    (pipes.lua:267); the server should reset that connection.
So: message-type pipe (works for message- and byte-read-mode clients), duplex, a large
buffer, and one fresh instance always waiting so a restarted game can connect at once.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Callable

import pywintypes
import win32file
import win32pipe
import winerror

log = logging.getLogger("x4webmap.pipe")

PIPE_REJECT_REMOTE_CLIENTS = 0x00000008      # local clients only
FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000   # fail if another server already owns the name
BUFFER_SIZE = 1 << 20                        # pipe quota (in/out); SN messages stay < 64 KB
READ_CHUNK = 1 << 16                         # ReadFile size; bigger messages use ERROR_MORE_DATA
GC_NOTICE = "garbage_collected"


class PipeServerError(RuntimeError):
    pass


class PipeServer:
    """Accepts any number of sequential/overlapping clients on \\\\.\\pipe\\<name>.

    on_message(line: str, conn_id: int) and on_status(event: str, conn_id: int) are called
    from worker threads; the caller must hop to its own loop (call_soon_threadsafe).
    """

    def __init__(self, name: str, on_message: Callable[[str, int], None],
                 on_status: Callable[[str, int], None]):
        self.name = name
        self.path = "\\\\.\\pipe\\" + name
        self.on_message = on_message
        self.on_status = on_status
        self._stop = threading.Event()
        self._conn_seq = 0
        self._lock = threading.Lock()
        self.active: set[int] = set()
        self._first = None
        self._accept_thread: threading.Thread | None = None

    # -- instances -----------------------------------------------------------------
    def _create_instance(self, first: bool):
        open_mode = win32pipe.PIPE_ACCESS_DUPLEX | (FILE_FLAG_FIRST_PIPE_INSTANCE if first else 0)
        pipe_mode = (win32pipe.PIPE_TYPE_MESSAGE | win32pipe.PIPE_READMODE_MESSAGE
                     | win32pipe.PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS)
        return win32pipe.CreateNamedPipe(
            self.path, open_mode, pipe_mode, win32pipe.PIPE_UNLIMITED_INSTANCES,
            BUFFER_SIZE, BUFFER_SIZE, 0, None)

    def start(self) -> None:
        try:
            self._first = self._create_instance(first=True)
        except pywintypes.error as e:
            if e.winerror in (winerror.ERROR_ACCESS_DENIED, winerror.ERROR_PIPE_BUSY):
                raise PipeServerError(
                    f"{self.path} is already served by another process "
                    f"(is a second x4webmap server running?)") from e
            raise
        self._accept_thread = threading.Thread(target=self._accept_loop, name="pipe-accept", daemon=True)
        self._accept_thread.start()
        log.info("pipe server listening on %s", self.path)

    def stop(self) -> None:
        self._stop.set()
        # Unblock ConnectNamedPipe with a throw-away local client.
        try:
            h = win32file.CreateFile(self.path, win32file.GENERIC_READ | win32file.GENERIC_WRITE,
                                     0, None, win32file.OPEN_EXISTING, 0, None)
            win32file.CloseHandle(h)
        except pywintypes.error:
            pass
        if self._accept_thread:
            self._accept_thread.join(timeout=2)

    # -- threads -------------------------------------------------------------------
    def _accept_loop(self) -> None:
        handle = self._first
        while not self._stop.is_set():
            try:
                win32pipe.ConnectNamedPipe(handle, None)
            except pywintypes.error as e:
                if e.winerror != winerror.ERROR_PIPE_CONNECTED:   # client raced us: still fine
                    log.warning("ConnectNamedPipe failed: %s; recreating instance", e)
                    self._close(handle)
                    time.sleep(0.2)
                    handle = self._new_instance_retry()
                    continue
            if self._stop.is_set():
                self._close(handle)
                break
            with self._lock:
                self._conn_seq += 1
                cid = self._conn_seq
            threading.Thread(target=self._reader, args=(handle, cid), name=f"pipe-conn-{cid}",
                             daemon=True).start()
            handle = self._new_instance_retry()

    def _new_instance_retry(self):
        while not self._stop.is_set():
            try:
                return self._create_instance(first=False)
            except pywintypes.error as e:
                log.error("CreateNamedPipe failed: %s; retrying in 1 s", e)
                time.sleep(1)
        return None

    def _reader(self, handle, cid: int) -> None:
        with self._lock:
            self.active.add(cid)
        self._status("connected", cid)
        reason = "closed by client"
        pending = b""
        try:
            while not self._stop.is_set():
                hr, data = win32file.ReadFile(handle, READ_CHUNK)
                pending += bytes(data)
                if hr == winerror.ERROR_MORE_DATA:
                    continue                      # rest of the same message follows
                raw, pending = pending, b""
                text = raw.decode("utf-8", errors="replace")
                if text.strip() == GC_NOTICE:
                    reason = "client sent garbage_collected (UI reload)"
                    break
                for line in text.splitlines():
                    if line.strip():
                        try:
                            self.on_message(line, cid)
                        except Exception:          # never let a handler kill the reader
                            log.exception("on_message failed")
        except pywintypes.error as e:
            if e.winerror not in (winerror.ERROR_BROKEN_PIPE, winerror.ERROR_PIPE_NOT_CONNECTED,
                                  winerror.ERROR_NO_DATA):
                reason = f"read error {e.winerror}: {e.strerror}"
        finally:
            try:
                win32pipe.DisconnectNamedPipe(handle)
            except pywintypes.error:
                pass
            self._close(handle)
            with self._lock:
                self.active.discard(cid)
            self._status("disconnected:" + reason, cid)

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
