import unittest

from session_boundary import process_is_unprivileged


PROFILE = (
    "Uid:\t140 140 140 140\nNoNewPrivs:\t1\nCapEff:\t0000000000000000\n"
    "CapPrm:\t0000000000000000\nCapAmb:\t0000000000000000\nCapBnd:\t0000000000000000\n"
)


class SessionIdentityTest(unittest.TestCase):
    def test_requires_the_same_non_root_ids_and_no_privileges(self):
        expected = PROFILE
        self.assertTrue(process_is_unprivileged(expected, 140))
        for value in (
            expected.replace("140 140 140 140", "0 140 140 140"),
            expected.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
            expected.replace("0000000000000000", "0000000000000001"),
            "Uid:\t140 140 140 140\n",
        ):
            with self.subTest(value=value):
                self.assertFalse(process_is_unprivileged(value, 140))
        self.assertFalse(process_is_unprivileged(expected, 0))

    def test_qemu_requires_an_empty_bounding_set_even_with_a_non_root_user(self):
        status = PROFILE.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0")
        self.assertTrue(process_is_unprivileged(status, 140, controller=False))
        bounded = status.replace("CapBnd:\t0000000000000000", "CapBnd:\t0000000000000001")
        self.assertFalse(process_is_unprivileged(bounded, 140, controller=False))
