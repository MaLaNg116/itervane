import socket
import unittest
from email.message import Message
from io import BytesIO
from unittest.mock import Mock, patch

import source_gateway as source


TARGET = "a" * 40


def pkt(line):
    return f"{len(line) + 4:04x}".encode() + line


def fetch(target=TARGET, depth=b"deepen 1", tail=b""):
    return pkt(b"want " + target.encode() + b" multi_ack_detailed no-done agent=git/2.43.0\n") + pkt(depth) + b"0000" + tail


def reply(status, media, body):
    headers = Message()
    headers["Content-Type"] = media
    content = BytesIO(body)
    return Mock(status=status, headers=headers, length=None, read1=Mock(side_effect=content.read1))


class SourceGatewayTest(unittest.TestCase):
    def setUp(self):
        self.origin = source.RegisteredOrigin.parse("https://code.example.org/team/project.git", {"code.example.org"})

    def test_registration_requires_the_exact_approved_https_origin_and_unambiguous_path(self):
        for url in (
            "http://code.example.org/team/project.git", "https://code.example.org:443/team/project.git",
            "https://name@code.example.org/team/project.git", "https://other.example.org/team/project.git",
            "https://code.example.org/team/../project.git", "https://code.example.org/team/%2e%2e/project.git",
            "https://code.example.org/team/project.git?", "https://code.example.org/team//project.git",
        ):
            with self.subTest(url=url), self.assertRaisesRegex(source.SourceRejected, "origin-rejected"):
                source.RegisteredOrigin.parse(url, {"code.example.org"})

    def test_one_nonpublic_answer_blocks_the_entire_resolution(self):
        for address in ("127.0.0.1", "10.1.2.3", "169.254.0.1", "100.64.0.1", "224.0.0.1"):
            records = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ("8.8.8.8", address)]
            with self.subTest(address=address), patch.object(source.socket, "getaddrinfo", return_value=records):
                with self.assertRaisesRegex(source.SourceRejected, "address-rejected"):
                    source.pin_public_address("code.example.org")

    def test_stateless_git_fetch_allows_only_the_exact_shallow_request_and_done(self):
        for body in (fetch(), fetch(tail=pkt(b"done\n"))):
            source.require_fixed_fetch(body, TARGET)
        for invalid in (fetch("b" * 40), fetch(depth=b"deepen 2"), fetch(tail=pkt(b"have " + TARGET.encode())),
                        fetch(tail=pkt(b"want " + TARGET.encode())), b"00ffwant", b"0001", b"0010short"):
            with self.subTest(body=invalid), self.assertRaises(source.SourceRejected):
                source.require_fixed_fetch(invalid, TARGET)

    def test_only_fixed_paths_are_dialed_and_no_io_occurs_after_close(self):
        gateway = source.SourceGateway(self.origin, TARGET)
        connection = Mock()
        connection.getresponse.side_effect = [reply(200, source.REFS_TYPE, b"refs"), reply(200, source.PACK_TYPE, b"pack")]
        with (
            patch.object(source, "pin_public_address", return_value="8.8.8.8") as pin,
            patch.object(source, "PinnedConnection", return_value=connection) as dial,
        ):
            with self.assertRaisesRegex(source.SourceRejected, "route-rejected"):
                gateway.request(b"P", fetch(), lambda: None)
            self.assertEqual(gateway.request(b"I", b"", lambda: None), b"refs")
            self.assertEqual(gateway.request(b"P", fetch(), lambda: None), b"pack")
            gateway.close()
            with self.assertRaisesRegex(source.SourceRejected, "source-closed"):
                gateway.request(b"I", b"", lambda: None)
        pin.assert_called_once_with(self.origin.host)
        self.assertEqual(dial.call_count, 2)
        self.assertEqual([call.args[:2] for call in connection.request.call_args_list], [
            ("GET", "/team/project.git/info/refs?service=git-upload-pack"), ("POST", "/team/project.git/git-upload-pack"),
        ])
        self.assertEqual(gateway.transferred, 8)

    def test_redirects_are_rejected_before_reading_the_body(self):
        gateway = source.SourceGateway(self.origin, TARGET)
        response = reply(302, source.REFS_TYPE, b"nothing")
        with self.assertRaisesRegex(source.SourceRejected, "redirect-rejected"):
            gateway.read_response(response, source.REFS_TYPE, lambda: None)
        response.read1.assert_not_called()
