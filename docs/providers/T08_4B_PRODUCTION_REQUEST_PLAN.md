# Separate actual 4B T08 plan

Coordinator-approved strategy: no generation, model pull, resource change or physical job has started by the provider track for this plan. Require an explicit validation booking and a new job/provider record; never resume or substitute into either failed job.

Use installed `qwen3:4b`, exact upstream digest `359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7`, model blob SHA-256 `3e4cb14174460404e7a233e531675303b2fbf7749c02f91864fe311ab6344e4f`, Apache-2.0, isolated Ollama 0.40.6 at `http://127.0.0.1:11438`. These are already installed and independently hashed; no pull is needed.

Recommended exact limits:

```json
{
  "contextLength": 8192,
  "timeoutMs": 900000,
  "production_maxOutputTokens": 4096,
  "wall_time_seconds": 3600,
  "per_command_timeout_seconds": 240,
  "max_tool_steps": 12,
  "max_output_bytes": 1048576,
  "required_verification": true,
  "fixture_memory_bytes": 8589934592,
  "fixture_memory_swap_bytes": 8589934592,
  "fixture_cpus": 4,
  "gpu": false
}
```

Keep the production agent's `budgeted.request` output cap, currently up to 4096 tokens when other budgets do not reduce it. Do not substitute a 512- or 2048-token harness override. Record the exact final forwarded request and its native `options.num_predict`; if production legitimately reduces the cap, preserve the actual value and cause. Exact total-token preflight remains unavailable for this adapter; do not add a hard total-token limit that would reject the job before generation.

The passive installed [envelope](actual-qwen3-4b-8192-passive-envelope.json) advertises context 262144 and a `Thinking` finetune with `thinking.values:[true]`, default `true`. Context 8192 is inside the advertised limit, but successful resource use at 8192 has not yet been measured. A hard non-thinking override is not supported. The coordinator selected faithful production generation: no `makeAdapter` thinking, temperature or output overrides. Omit `think` and temperature when the worker omits them; record model-default thinking `true` and temperature 0.6. Use the literal task below without adding `/no_think`; there is no hard or soft thinking-control claim in this attempt.

The passive [resource snapshot](actual-qwen3-4b-8192-resource-envelope.txt) confirms 8 GiB memory/swap, four CPUs, no device/GPU grants, OOM kills zero, approximately 52.23 GB available WSL memory, an empty `/api/ps`, zero CPU and idle runner slots. The prior 4096-context generation sampled approximately 5.46 GiB excluding inactive file cache. Assuming FP16 keys/values, the advertised 36 layers, eight KV heads and 128-element key/value dimensions imply about 604 MB extra KV storage for 4096 additional context positions. This is an estimate, not measured 8192-context memory. Keep the 8 GiB bound; record actual memory/pressure/OOM observations and stop the campaign honestly on resource failure without fallback or an in-flight limit increase.

Use the same concise profile instructions and task prompt from [the separate 1.5B plan](T08_NEXT_ATTEMPT_PLAN.md), with all six current production tools and strengthened relative-path schemas. No synthetic tool results, path rewriting or argument coercion may enter the physical run. Record the exact prompt/profile/schema hashes from the selected immutable build. Actual verification and both retained artifacts remain mandatory; a successful command alone is not an acceptance pass.

Why this is credible: this exact 4B model already generated a valid command proposal and physically ran the 180-second command. Its subsequent actual response used 1567 input tokens and exhausted the previous 1024-token output cap without a visible response or tool call; runner logs reported no context truncation for that attempt. Restoring the production 4096-token allowance and giving it 8192 context removes the artificial 1024-token fixture ceiling while leaving strict tool validation intact. At the observed roughly 3.58 output tokens/second, using the full 4096 output allowance could still exceed the 900-second request deadline. The deadline is an independent bound, not a guarantee the entire allowance can be consumed. A timeout remains a transport interruption with uncertain server termination, not an unsupported-capability verdict or permission to replay.

Before booking, preserve the failed 1.5B job separately: `b96bd0da-3b20-4026-8f17-27d248e05f65` has eight completed real HTTP generation requests and twelve rejected proposals, zero host operations, then a fixture guard threw before the intended tool-less ninth network request. The ninth inference ledger row is not evidence of a ninth upstream request. Its two conservative uncertain provider reservations and workspace lock remain historical; no DB rewrites or reservation releases were performed by the provider track. Validation must confirm its future capture guard accepts a legitimate absent/empty tools field and preserves the original launched fixture/error evidence. Do not replay that interrupted job or describe idle observations as retroactively proving a ninth provider completion.

Capture provider/model/server identity, exact forwarded bodies after instrumentation, tools-present versus tool-less closing rounds, immutable worker/Go/harness identities, every persisted model proposal/rejection/result, actual token/finish/timing data, context/truncation and resource observations, operation PID/counter and durable log events, browser timing, worker/API absence and reconciliation, real file verification and retained-byte download with host offline. End with the observed whole-workflow outcome; do not combine earlier component passes into this new job's result.
