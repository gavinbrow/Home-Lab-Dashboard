import unittest
from cpu_reference import Reference


class TimingComparisonTests(unittest.TestCase):
    def test_weighted_overlap_uses_exact_collector_bounds(self):
        reference = Reference()
        reference.intervals = [(i * 20_000_000, (i + 1) * 20_000_000, 10 if i < 25 else 30, 100_000) for i in range(50)]
        result = reference.summarize(0, 1_000_000_000, 20)
        self.assertEqual(result['reference_percent'], 20)
        self.assertEqual(result['coverage_ratio'], 1)
        self.assertTrue(result['matched'])
        self.assertAlmostEqual(result['tolerance_percentage_points'], 5.02)

    def test_missing_reference_time_cannot_pass(self):
        reference = Reference()
        reference.intervals = [(i * 20_000_000, (i + 1) * 20_000_000, 0, 0) for i in range(49)]
        result = reference.summarize(0, 1_000_000_000, 0)
        self.assertFalse(result['conclusive'])
        self.assertFalse(result['matched'])

    def test_short_window_and_large_difference_cannot_claim_accuracy(self):
        reference = Reference()
        reference.intervals = [(i * 20_000_000, (i + 1) * 20_000_000, 20, 0) for i in range(50)]
        self.assertFalse(reference.summarize(0, 200_000_000, 20)['conclusive'])
        self.assertFalse(reference.summarize(0, 1_000_000_000, 40)['matched'])
        self.assertFalse(reference.summarize(0, 1_000_000_000, None)['matched'])


if __name__ == '__main__':
    unittest.main()
