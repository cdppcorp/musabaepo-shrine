"""HTTP 비교 시험 도구: 날것의 HTTP/1.1 요청(주소를 손대지 않음)과 응답 읽기, Node · Python 서버 띄우기."""

from __future__ import annotations

import os
import socket
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

# 비교에서 빼는 머리글: 시각 · 서버 이름 · 연결 관리(hop-by-hop, Caddy가 다시 정함)
IGNORED_HEADERS = frozenset({"date", "server", "connection", "keep-alive"})


@dataclass
class RawResponse:
    status: int
    headers: list[tuple[str, str]]
    body: bytes
    raw_head: str = ""

    def header(self, name: str) -> str | None:
        for k, v in self.headers:
            if k.lower() == name.lower():
                return v
        return None

    def normalized_headers(self) -> list[tuple[str, str]]:
        return sorted((k.lower(), v) for k, v in self.headers if k.lower() not in IGNORED_HEADERS)


@dataclass
class Req:
    method: str
    target: str
    headers: list[tuple[str, str]] = field(default_factory=list)
    name: str = ""
    #: HTTP 파서 단계에서 거절되는 요청 (앱까지 오지 않음): 상태만 비교
    parser_reject: bool = False

    def label(self) -> str:
        extra = ", ".join(f"{k}: {v}" for k, v in self.headers)
        return self.name or f"{self.method} {self.target}" + (f" [{extra}]" if extra else "")


def send_raw(port: int, method: str, target: str, headers: list[tuple[str, str]], timeout: float = 10.0) -> RawResponse:
    lines = [f"{method} {target} HTTP/1.1"]
    lines += [f"{k}: {v}" for k, v in headers]
    lines.append("Connection: close")
    data = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        s.sendall(data)
        chunks = []
        while True:
            c = s.recv(65536)
            if not c:
                break
            chunks.append(c)
    raw = b"".join(chunks)
    head, _, rest = raw.partition(b"\r\n\r\n")
    head_lines = head.decode("latin-1").split("\r\n")
    status = int(head_lines[0].split(" ")[1])
    hdrs = []
    for line in head_lines[1:]:
        k, _, v = line.partition(":")
        hdrs.append((k.strip(), v.strip()))
    te = next((v for k, v in hdrs if k.lower() == "transfer-encoding"), "")
    body = _dechunk(rest) if "chunked" in te.lower() else rest
    return RawResponse(status, hdrs, body, head.decode("latin-1"))


def _dechunk(data: bytes) -> bytes:
    out = bytearray()
    while data:
        size_line, _, data = data.partition(b"\r\n")
        size = int(size_line.split(b";")[0], 16)
        if size == 0:
            break
        out += data[:size]
        data = data[size + 2 :]
    return bytes(out)


def wait_ready(port: int, proc: subprocess.Popen, log: Path, timeout: float = 60.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"서버가 바로 끝났습니다 (port {port}, exit {proc.returncode}):\n{tail(log)}")
        try:
            r = send_raw(port, "GET", "/healthz", [("Host", "shrine.local")], timeout=2)
            if r.status in (200, 503):
                return
        except OSError:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"서버가 {timeout}초 안에 뜨지 않았습니다 (port {port}):\n{tail(log)}")


def tail(path: Path, n: int = 40) -> str:
    try:
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-n:])
    except OSError:
        return "(로그 없음)"


def base_env() -> dict[str, str]:
    keep = ("PATH", "SYSTEMROOT", "SYSTEMDRIVE", "TEMP", "TMP", "HOME", "USERPROFILE", "COMSPEC", "PATHEXT", "WINDIR")
    return {k: v for k, v in os.environ.items() if k.upper() in keep}


def start(cmd: list[str], cwd: Path, env: dict[str, str], log: Path) -> subprocess.Popen:
    f = open(log, "wb")  # noqa: SIM115 (프로세스가 끝날 때까지 엶)
    return subprocess.Popen(cmd, cwd=cwd, env=env, stdout=f, stderr=subprocess.STDOUT)


def stop(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(5)
