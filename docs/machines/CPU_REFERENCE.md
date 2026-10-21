# Local CPU comparison method

This is a local Windows/WSL component experiment, not whole T02/T03 acceptance or proof for an operator's enrolled hosts. Existing memory/volume/network evidence remains in LOCAL_WINDOWS_REFERENCE.json. GPU configuration is absent and unmatched network interfaces remain unverified.

The collector sample's observed_at precedes host inventory collection and cannot establish its CPU sampling window. The host owner is providing a collect-only diagnostic helper with --cpu-window and --cpu-evidence-file. It reports cpu_started_at/cpu_completed_at around the actual CPU measurement, without changing the telemetry wire schema. Reports retain only CPU values, UTC bounds and comparison metadata; raw collector inventory stays in memory.

cpu_reference.py samples an independent OS interface roughly every 20 ms. Windows uses the English PDH Processor(_Total) % Processor Time counter through native PDH functions, not gopsutil. Linux reads aggregate /proc/stat counters directly, sums user/nice/system/idle/iowait/irq/softirq/steal, and subtracts idle+iowait. Guest fields are not added twice. Windows and WSL each compare their own OS totals; Windows global utilization is not substituted for WSL utilization.

The script waits for a valid reference interval before invoking the collector. It weights each independently measured reference interval by overlap with the collector's exact CPU window. A comparison is conclusive only with at least 99.9% coverage, no reference interval longer than 60 ms, and a calculated tolerance at most 7 percentage points. The declared tolerance is 1 percentage point plus 200*(largest reference interval + reference read timestamp uncertainty)/actual CPU-window duration. The two edge intervals conservatively account for unknown activity within the reference sampling resolution. PDH startup/unavailable values are recorded as errors/gaps, never replaced by zero.

The diagnostic interval is one second to reduce edge uncertainty. Agreement at this interval does not independently establish accuracy at the production default 200 ms, sustained load response, or all scheduler/hypervisor conditions. All actual values, errors, coverage and tolerance are retained, including failed/inconclusive results.

The baseline phase creates no workload. The load phase requires --fixture-idle-confirmed after current provider and validation owners explicitly release a window; the flag alone is not a substitute for that coordination. It launches at most two single-thread workers, each self-limited to eight seconds, and stops remaining workers in finally. A load comparison becomes inconclusive if both workers are no longer running at its window end. Windows and Linux load phases need separate idle windows; no automatic retry is authorized.

Example after the owner publishes the helper and confirms the fixture is idle:

```powershell
python docs/machines/cpu_reference.py --collector '<explicit local Windows helper>' --output docs/machines/CPU_WINDOWS_BASELINE.json
python docs/machines/cpu_reference.py --collector '<explicit local Windows helper>' --phase load --fixture-idle-confirmed --output docs/machines/CPU_WINDOWS_LOAD.json
```

For WSL, run the same Python source with python3 and an explicitly selected Linux helper under the existing Ubuntu distribution. Do not contact other hosts, install services, change affinity/priority, or create accounts.

Source definitions: [Microsoft PDH formatting API](https://learn.microsoft.com/en-us/windows/win32/api/pdh/nf-pdh-pdhgetformattedcountervalue), [Linux proc filesystem](https://www.kernel.org/doc/html/latest/filesystems/proc.html). Linux accounting and short interval quantization have limits; measurements must retain those limits rather than imply exact physical utilization.

Initial calibration: independent Windows PDH yielded 36 valid intervals, with one startup unavailable value recorded; independent WSL /proc/stat yielded 20 valid intervals with zero errors. Both samplers stopped cleanly. No load process was launched. The first offered inference-idle window was released immediately to validation while the exact-timing helper was being built. The helper subsequently became available for the baselines below.

## Actual baseline results

The READY8 helpers were SHA256-verified before the baseline runs: Windows E4076D27AEDA2812E198C00286987B57F3726678FB12C3A98BD8F620C3971585; Linux 97668CCEB608E122714A8EE0BE3B4DA0B810D4F7507B94FD8166090F9913A29D. These runs create no controlled load and do not assume the rest of the system is idle.

CPU_LINUX_BASELINE.json records three matched one-second samples against direct /proc/stat reads, with full coverage, zero reference errors and absolute differences 0.004–0.036 percentage points. This is actual local WSL diagnostic-interval agreement.

CPU_WINDOWS_BASELINE.json remains **inconclusive**, with zero conclusive samples. PDH returned invalid intervals, leaving only 87.6–96.9% reference coverage. Its approximately 32 ms largest intervals also produced 7.46–7.58 percentage-point timing tolerances, exceeding the unchanged 7-point ceiling. Collector/reference differences of 0.12–3.86 points do not override those failed prerequisites. No gaps were filled with zero or interpolation across unavailable counter intervals.

With the root coordinator's approval, CPU_WINDOWS_SYSTEM_TIMES_BASELINE.json records a separate corroborating implementation comparison. A Python ctypes reader samples GetSystemTimes at a 10 ms target cadence and calculates non-idle/(kernel+user), accounting for the documented inclusion of idle in kernel time. It does not call gopsutil, but uses the **same underlying Windows OS primitive** as the collector, so it is not independent-primitive accuracy proof. Three samples matched with full coverage, no reference errors, differences 0.27–1.57 points and calculated tolerances about 4.31 points. This does not change the PDH result. See [Microsoft GetSystemTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getsystemtimes).

All baseline artifacts report the samplers stopped, workers exited and temporary timing files removed.

## Actual bounded-load results

Validation explicitly released the inference/recovery fixture after its physical 180-second command reconciled, before its next model request. The two sequential load phases completed in 7.76 seconds total, 2026-10-21 05:21:00–07 UTC. Each phase launched two single-thread Python arithmetic workers, each self-limited to eight seconds; both workers were still running at every measurement-window end and were stopped in cleanup. No model request, service, account or system setting was changed. Validation received the DONE notification immediately after completion.

CPU_LINUX_LOAD.json records three matched one-second samples against /proc/stat with full coverage, zero errors, absolute differences 0.010–0.052 percentage points and calculated tolerances 5.07–5.09 points. Together with baseline, six local WSL diagnostic samples agree under the predeclared timing rule.

CPU_WINDOWS_SYSTEM_TIMES_LOAD.json records three matched corroborating samples, full coverage, zero errors, differences 1.85–2.68 points and calculated tolerances 4.28–4.32 points. This is still a separate implementation comparison using the same underlying Windows primitive, not independent PDH proof. The original CPU_WINDOWS_BASELINE.json remains inconclusive with its original 7-point ceiling. Background OS activity was not fully controlled, so these phase comparisons do not prove a monotonic response to the added workers or sustained full-load accuracy.

All load artifacts include immutable helper hashes, exact CPU-window timestamps, values, coverage, tolerances and cleanup booleans; all cleanup booleans are true. The existing eight matched memory/volume/network checks remain unchanged. Unmatched network interfaces and unconfigured GPU are not promoted by CPU success.

Remaining measurement gates: production-default 200 ms accuracy; independent Windows PDH or another independent measurement that meets full coverage and the unchanged timing limit; controlled sustained/idle-load accuracy on explicitly enrolled Windows/Linux hosts; and real configured GPU measurements where hardware and adapter configuration exist. No full T02/T03 pass is claimed.
