"""The host side of the one-repository, read-only Git HTTPS transfer."""

import http.client
import ipaddress
import re
import socket
import ssl
from dataclasses import dataclass
from urllib.parse import urlsplit

from source_wire import MAX_REQUEST_BYTES, MAX_TRANSFER_BYTES, PACK_TYPE, REFS_TYPE, UPLOAD_TYPE


MAX_REQUESTS = 8
IO_SECONDS = 5
LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
SEGMENT = re.compile(r"[A-Za-z0-9._-]{1,120}")
COMMIT = re.compile(r"[0-9a-f]{40}")


class SourceRejected(Exception):
    pass


@dataclass(frozen=True)
class RegisteredOrigin:
    host: str
    path: str

    @classmethod
    def parse(cls, value, allowed_hosts):
        if not isinstance(value, str) or len(value) > 768 or not value.isascii():
            raise SourceRejected("origin-rejected")
        try:
            url = urlsplit(value)
            host = url.hostname or ""
        except ValueError as error:
            raise SourceRejected("origin-rejected") from error
        labels = host.split(".")
        if (
            host not in allowed_hosts or len(labels) < 2 or len(host) > 253
            or any(not LABEL.fullmatch(label) for label in labels) or not labels[-1][0].isalpha()
            or value != f"https://{host}{url.path}"
            or not url.path.startswith("/")
            or any(part in (".", "..") or not SEGMENT.fullmatch(part) for part in url.path[1:].split("/"))
        ):
            raise SourceRejected("origin-rejected")
        return cls(host, url.path)


def pin_public_address(host):
    # The source relay intentionally dials IPv4 here. It never falls back to a
    # freshly resolved host or to an unchecked IPv6/translated address.
    answers = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)
    addresses = {ipaddress.IPv4Address(answer[4][0]) for answer in answers}
    if not addresses or any(not ip.is_global or ip.is_multicast or ip.is_reserved for ip in addresses):
        raise SourceRejected("address-rejected")
    return str(min(addresses))


def require_fixed_fetch(body, commit):
    if not 0 < len(body) <= MAX_REQUEST_BYTES or not COMMIT.fullmatch(commit):
        raise SourceRejected("fetch-request-rejected")
    packets = []
    offset = 0
    while offset < len(body):
        header = body[offset:offset + 4]
        if not re.fullmatch(b"[0-9a-f]{4}", header):
            raise SourceRejected("fetch-request-rejected")
        size = int(header, 16)
        if size == 0:
            packets.append(None)
            offset += 4
        else:
            if size < 5 or offset + size > len(body):
                raise SourceRejected("fetch-request-rejected")
            packets.append(body[offset + 4:offset + size].removesuffix(b"\n"))
            offset += size
        if len(packets) > 6:
            raise SourceRejected("fetch-request-rejected")

    target = commit.encode("ascii")
    wanted = re.compile(b"want " + target + b"(?: [A-Za-z0-9._=/ -]{1,512})?")
    if not packets[0] or not wanted.fullmatch(packets[0]):
        raise SourceRejected("commit-rejected")
    rest = packets[1:]
    if rest[:1] == [b"shallow " + target]:
        rest = rest[1:]
    if rest[:2] != [b"deepen 1", None] or rest[2:] not in ([], [b"done"], [b"done", None]):
        raise SourceRejected("fetch-request-rejected")


class PinnedConnection(http.client.HTTPSConnection):
    def __init__(self, host, address, tls):
        super().__init__(host, 443, timeout=IO_SECONDS, context=tls)
        self.address = address
        self.tls = tls

    def connect(self):
        raw = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            raw.settimeout(self.timeout)
            raw.connect((self.address, 443))
            self.sock = self.tls.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


class SourceGateway:
    def __init__(self, origin, commit):
        self.origin = origin
        self.commit = commit
        self.address = None
        self.tls = None
        self.requests = 0
        self.transferred = 0
        self.closed = False
        self.discovered = False
        self.fetched = False

    def close(self):
        self.closed = True

    def request(self, kind, body, check_deadline):
        if self.closed:
            raise SourceRejected("source-closed")
        if self.requests >= MAX_REQUESTS:
            raise SourceRejected("request-budget")
        headers = {"Accept-Encoding": "identity", "User-Agent": "Itervane-Source/1"}
        if kind == b"I" and not body and self.requests == 0:
            method, path, media = "GET", "/info/refs?service=git-upload-pack", REFS_TYPE
        elif kind == b"P" and self.discovered:
            require_fixed_fetch(body, self.commit)
            method, path, media = "POST", "/git-upload-pack", PACK_TYPE
            headers["Content-Type"] = UPLOAD_TYPE
        else:
            raise SourceRejected("route-rejected")

        check_deadline()
        self.requests += 1
        try:
            if self.address is None:
                self.address = pin_public_address(self.origin.host)
                self.tls = ssl.create_default_context()
            check_deadline()
            connection = PinnedConnection(self.origin.host, self.address, self.tls)
            try:
                connection.request(method, self.origin.path + path, body if body else None, headers)
                payload = self.read_response(connection.getresponse(), media, check_deadline)
            finally:
                connection.close()
        except (OSError, http.client.HTTPException) as error:
            raise SourceRejected("https-failed") from error
        self.discovered = True
        self.fetched = self.fetched or kind == b"P"
        return payload

    def read_response(self, response, media, check_deadline):
        if 300 <= response.status < 400:
            raise SourceRejected("redirect-rejected")
        if response.status != 200 or response.headers.get_content_type() != media:
            raise SourceRejected("response-rejected")
        if response.headers.get("Content-Encoding", "identity").lower() != "identity":
            raise SourceRejected("response-rejected")
        remaining = MAX_TRANSFER_BYTES - self.transferred
        if response.length is not None and response.length > remaining:
            raise SourceRejected("transfer-budget")
        payload = bytearray()
        while True:
            check_deadline()
            chunk = response.read1(min(65536, remaining - len(payload) + 1))
            if not chunk:
                break
            payload.extend(chunk)
            if len(payload) > remaining:
                raise SourceRejected("transfer-budget")
        if not payload or response.length not in (None, 0):
            raise SourceRejected("response-rejected")
        self.transferred += len(payload)
        return bytes(payload)
