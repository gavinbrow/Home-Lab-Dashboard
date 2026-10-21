"""Read-only CPU reference against an explicitly supplied local collector.

Only --phase load --fixture-idle-confirmed permits two bounded child workers.
Raw collector output stays in memory; reports contain CPU values/timing only.
"""
import argparse
import ctypes
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time


def utc(ns):
    return dt.datetime.fromtimestamp(ns / 1e9, dt.timezone.utc).isoformat()


class Reference:
    def __init__(self, windows_source='pdh'):
        self.intervals = []
        self.errors = []
        self.stop = threading.Event()
        self.ready = threading.Event()
        self.windows_source = windows_source
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        try:
            if os.name == 'nt':
                if self.windows_source == 'system-times':
                    self.windows_system_times()
                else:
                    self.windows()
            else:
                self.linux()
        except Exception as exc:
            self.errors.append(type(exc).__name__ + ':' + str(exc))

    def linux(self):
        def read():
            before = time.time_ns()
            with open('/proc/stat', encoding='ascii') as source:
                fields = list(map(int, source.readline().split()[1:9]))
            after = time.time_ns()
            # guest/guest_nice are already included in user/nice; never add twice.
            return (before + after) // 2, sum(fields), fields[3] + fields[4], after - before
        previous = read()
        while not self.stop.wait(.02):
            current = read()
            total, idle = current[1] - previous[1], current[2] - previous[2]
            if total > 0 and 0 <= idle <= total:
                self.intervals.append((previous[0], current[0], 100 * (1 - idle / total), max(previous[3], current[3]) / 2))
                self.ready.set()
            else:
                self.errors.append('proc_counter_reset_or_invalid_delta')
            previous = current

    def windows(self):
        pdh = ctypes.WinDLL('pdh.dll')
        handle = ctypes.c_void_p
        class Value(ctypes.Structure):
            _fields_ = [('status', ctypes.c_uint32), ('value', ctypes.c_double)]
        pdh.PdhOpenQueryW.argtypes = [ctypes.c_wchar_p, ctypes.c_size_t, ctypes.POINTER(handle)]
        pdh.PdhAddEnglishCounterW.argtypes = [handle, ctypes.c_wchar_p, ctypes.c_size_t, ctypes.POINTER(handle)]
        pdh.PdhCollectQueryData.argtypes = [handle]
        pdh.PdhGetFormattedCounterValue.argtypes = [handle, ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(Value)]
        pdh.PdhCloseQuery.argtypes = [handle]
        query, counter = handle(), handle()
        def checked(status):
            if status:
                raise RuntimeError('PDH_status_' + hex(status & 0xffffffff))
        checked(pdh.PdhOpenQueryW(None, 0, ctypes.byref(query)))
        try:
            checked(pdh.PdhAddEnglishCounterW(query, r'\Processor(_Total)\% Processor Time', 0, ctypes.byref(counter)))
            def collect():
                before = time.time_ns()
                checked(pdh.PdhCollectQueryData(query))
                after = time.time_ns()
                return (before + after) // 2, (after - before) / 2
            previous = collect()
            while not self.stop.wait(.02):
                current = collect()
                value = Value()
                status = pdh.PdhGetFormattedCounterValue(counter, 0x200 | 0x8000, None, ctypes.byref(value))
                if status == 0 and value.status in (0, 1) and 0 <= value.value <= 100:
                    self.intervals.append((previous[0], current[0], value.value, max(previous[1], current[1])))
                    self.ready.set()
                else:
                    self.errors.append('PDH_unavailable_' + hex(status & 0xffffffff) + '_' + hex(value.status))
                previous = current
        finally:
            pdh.PdhCloseQuery(query)

    def windows_system_times(self):
        # Separate implementation comparison, explicitly not an independent OS
        # primitive: the collector's Windows library also uses GetSystemTimes.
        kernel = ctypes.WinDLL('kernel32.dll', use_last_error=True)
        class FileTime(ctypes.Structure):
            _fields_ = [('low', ctypes.c_uint32), ('high', ctypes.c_uint32)]
            def number(self):
                return (self.high << 32) | self.low
        kernel.GetSystemTimes.argtypes = [ctypes.POINTER(FileTime)] * 3
        kernel.GetSystemTimes.restype = ctypes.c_int
        def read():
            idle, system, user = FileTime(), FileTime(), FileTime()
            before = time.time_ns()
            if not kernel.GetSystemTimes(ctypes.byref(idle), ctypes.byref(system), ctypes.byref(user)):
                raise RuntimeError('GetSystemTimes_failed_' + str(ctypes.get_last_error()))
            after = time.time_ns()
            return (before + after) // 2, system.number() + user.number(), idle.number(), (after - before) / 2
        previous = read()
        while not self.stop.wait(.01):
            current = read()
            total, idle = current[1] - previous[1], current[2] - previous[2]
            if total > 0 and 0 <= idle <= total:
                self.intervals.append((previous[0], current[0], 100 * (1 - idle / total), max(previous[3], current[3])))
                self.ready.set()
            else:
                self.errors.append('GetSystemTimes_zero_or_invalid_delta')
            previous = current

    def summarize(self, start, end, actual):
        selected = [row for row in self.intervals if row[1] > start and row[0] < end]
        overlaps = [(max(0, min(end, row[1]) - max(start, row[0])), row) for row in selected]
        covered = sum(length for length, _ in overlaps)
        duration = end - start
        reference = sum(length * row[2] for length, row in overlaps) / covered if covered else None
        gap = max((row[1] - row[0] for _, row in overlaps), default=duration)
        read_uncertainty = max((row[3] for _, row in overlaps), default=duration)
        # Worst-case two edge intervals at 0..100% plus reference read timing.
        alignment_bound = 200 * (gap + read_uncertainty) / duration
        tolerance = 1 + alignment_bound
        conclusive = covered >= duration * .999 and gap <= 60000000 and tolerance <= 7
        difference = abs(actual - reference) if reference is not None and actual is not None else None
        return dict(reference_percent=reference, collector_percent=actual, absolute_difference_percentage_points=difference,
                    coverage_ratio=covered / duration, max_reference_interval_ms=gap / 1e6,
                    reference_read_uncertainty_ms=read_uncertainty / 1e6,
                    tolerance_percentage_points=tolerance, tolerance_formula='1pp + 200*(max_reference_interval+read_uncertainty)/actual_CPU_window',
                    conclusive=conclusive, matched=bool(conclusive and difference is not None and difference <= tolerance))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--collector', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--phase', choices=['baseline', 'load'], default='baseline')
    parser.add_argument('--fixture-idle-confirmed', action='store_true')
    parser.add_argument('--windows-reference', choices=['pdh', 'system-times'], default='pdh')
    args = parser.parse_args()
    if args.phase == 'load' and not args.fixture_idle_confirmed:
        parser.error('load requires an explicitly confirmed idle fixture window')
    reference = Reference(args.windows_reference)
    workers = []
    temporary = None
    with open(args.collector, 'rb') as binary:
        helper_sha256 = hashlib.file_digest(binary, 'sha256').hexdigest()
    report = dict(schema_version=1, scope='local component CPU reference; not whole T02/T03 acceptance',
                  platform='windows' if os.name == 'nt' else 'linux', phase=args.phase, started_at=utc(time.time_ns()),
                  helper_sha256=helper_sha256, diagnostic_cpu_window_seconds=1,
                  background_workload='not assumed idle' if args.phase == 'baseline' else 'fixture idle window explicitly confirmed',
                  reference='PDH English Processor(_Total) % Processor Time' if os.name == 'nt' else '/proc/stat aggregate non-idle delta (idle+iowait excluded)',
                  source_definitions=['https://learn.microsoft.com/en-us/windows/win32/api/pdh/nf-pdh-pdhgetformattedcountervalue',
                                      'https://www.kernel.org/doc/html/latest/filesystems/proc.html'], samples=[])
    if os.name == 'nt' and args.windows_reference == 'system-times':
        report['reference'] = 'GetSystemTimes independent implementation; same underlying OS primitive as gopsutil, corroboration only'
        report['source_definitions'].append('https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getsystemtimes')
        report['reference_sampling_target_ms'] = 10
        report['pdh_result_unchanged'] = 'CPU_WINDOWS_BASELINE.json remains inconclusive; this is a separate comparison'
    try:
        reference.thread.start()
        if not reference.ready.wait(timeout=3):
            raise RuntimeError('Independent CPU reference did not become available; no comparison attempted')
        if args.phase == 'load':
            # Two single-thread CPU workers, eight seconds each, no I/O or child spawning.
            worker = 'import time;end=time.monotonic()+8;x=1\nwhile time.monotonic()<end:x=(x*1664525+1013904223)&0xffffffff'
            workers = [subprocess.Popen([sys.executable, '-c', worker], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for _ in range(2)]
            report['load'] = dict(workers=2, duration_limit_seconds=8, cpu_limit='at most two single-thread workers', fixture_idle_confirmed=True)
            time.sleep(.25)
        with tempfile.TemporaryDirectory(prefix='homelab-cpu-ref-') as temporary:
            for index in range(3):
                evidence = Path(temporary) / ('window-' + str(index) + '.json')
                completed = subprocess.run([args.collector, 'collect', '--machine-id', '11111111-1111-4111-8111-111111111111',
                                            '--cpu-window', '1s', '--cpu-evidence-file', str(evidence.resolve())], capture_output=True, text=True, timeout=5, check=True)
                sample = json.loads(completed.stdout)
                cpu = next(item for item in sample['metrics'] if item['name'] == 'cpu_utilization')
                window = json.loads(evidence.read_text(encoding='utf-8'))
                start = int(dt.datetime.fromisoformat(window['cpu_started_at'].replace('Z', '+00:00')).timestamp() * 1e9)
                end = int(dt.datetime.fromisoformat(window['cpu_completed_at'].replace('Z', '+00:00')).timestamp() * 1e9)
                time.sleep(.07)  # Obtain reference coverage through the exact CPU end boundary.
                comparison = reference.summarize(start, end, cpu['value'])
                if workers:
                    comparison['load_workers_still_running_at_window_end'] = sum(worker.poll() is None for worker in workers)
                    if comparison['load_workers_still_running_at_window_end'] != 2:
                        comparison['conclusive'] = comparison['matched'] = False
                report['samples'].append(dict(cpu_started_at=window['cpu_started_at'], cpu_completed_at=window['cpu_completed_at'],
                                              actual_window_seconds=(end - start) / 1e9, availability=cpu['availability'], reason=cpu['reason'],
                                              **comparison))
    finally:
        reference.stop.set()
        reference.thread.join(timeout=3)
        for worker in workers:
            if worker.poll() is None:
                worker.terminate()
            worker.wait(timeout=3)
        report['completed_at'] = utc(time.time_ns())
        report['reference_errors'] = reference.errors
        report['cleanup'] = dict(sampler_stopped=not reference.thread.is_alive(),
                                 load_workers_exited=all(worker.poll() is not None for worker in workers),
                                 temporary_files_removed=temporary is None or not Path(temporary).exists())
        report['matched_samples'] = sum(item['matched'] for item in report['samples'])
        Path(args.output).write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({key: report[key] for key in ['platform', 'phase', 'matched_samples', 'reference_errors', 'cleanup']}))


if __name__ == '__main__':
    main()
