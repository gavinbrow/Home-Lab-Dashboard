# One proposed actual T08 attempt

Status: coordinator approved exactly one new actual attempt after the coherent path-schema/helper-11 cut. No inference, model pull or physical job was started by the provider track for this plan. Validation owns the new job and endpoint booking.

Use the already installed `qwen2.5:1.5b`, digest `65ec06548149b04c096a120e4a6da9d4017ea809c91734ea5631e89f96ddc57b`, against isolated Ollama 0.40.6 at `http://127.0.0.1:11438`. This is a separate new provider/model/job record, with no failed-job replay or model substitution. Preserve the existing Qwen3 failures and the earlier Qwen2.5 file-workflow pass independently.

Recommended exact generation and resource settings:

```json
{
  "model": "qwen2.5:1.5b",
  "temperature": 0,
  "maxOutputTokens": 512,
  "contextLength": 4096,
  "provider_timeout_ms": 90000,
  "max_tool_steps": 12,
  "wall_time_seconds": 1200,
  "per_command_timeout_seconds": 240,
  "max_output_bytes": 1048576,
  "required_verification": true,
  "provider_pool_concurrency": 1,
  "fixture_memory_bytes": 8589934592,
  "fixture_cpus": 4,
  "gpu": false
}
```

Omit `thinking` from the adapter request and omit native `think` on the wire. The passive installed [show response](actual-qwen25-current-thinking-support.json) advertises `completion` and `tools`, with no thinking capability/control metadata. This uses the model's normal non-thinking behavior without claiming a supported hard override. Previous component requests accepted `false`, but that is not evidence of a discoverable control for this exact installation. Capture the actual forwarded request to confirm a wrapper does not add the prior 4B model's `thinking:true` setting.

Use the current production six-tool set from profile permissions `run_command`, `file.read`, `artifact.retain`: `list_files`, `read_file`, `run_command`, `verify_command`, `verify_file`, `publish_artifact`. Do not remove constraints or transform model arguments. The strengthened file-path schemas must be present in the selected worker image. The strategy-time schema fingerprint is `afa92bc559b0660ae94b5c55ec24543e60caa7f8dba357cbfabde7531855498b`, 7043 UTF-8 bytes; capture the actual selected build's schema hash again because later reviewed fixes may change it. Byte size is not a token count. Preserve actual reported input counts, configured context and runner truncation observations; exact tokenizer preflight is unavailable for this adapter.

Exact profile instructions:

```text
Complete the requested task autonomously using structured tools. Follow each tool's JSON schema. File tool paths are relative to the workspace; never prefix them with /workspace/project/. A rejection marked executed:false did not run: repair only the rejected arguments. An accepted or running command must not be launched again. A successful command result does not replace actual file verification or artifact retention. Do not ask the user to perform any step. Do not fabricate tool results.
```

Exact task prompt:

```text
Run this command exactly once using run_command:
{"executable":"/usr/local/bin/node","args":["/workspace/project/sentinel.mjs","/workspace/project","trusted-operation","180"]}
The args array has exactly four strings. Its first string is /workspace/project/sentinel.mjs. Do not put /usr/local/bin/node inside args.

After that command succeeds, perform these workspace file operations in this order:
verify_file {"path":"sentinel-report.txt"}
verify_file {"path":"sentinel-binary.bin"}
publish_artifact {"path":"sentinel-report.txt","mime_type":"text/plain"}
publish_artifact {"path":"sentinel-binary.bin","mime_type":"application/octet-stream"}

Those file paths are literal workspace-relative names, without /workspace/project/. Omit sha256 when it is unknown. You may propose the five structured tool calls together in the listed order; execution must wait for each preceding tool to finish. Never repeat the accepted command. Finish only after both actual verifications and both retained artifacts succeed.
```

Why this option: the 1.5B model already passed the actual file/verification workflow, generated a five-call plan in 28.85 seconds and corrected its command arguments in 36.16 seconds. Its remaining observed failure was absolute file paths under the old broad string schemas. The general path contract now rejects those arguments before execution and returns the expected schema through the existing corrective path. Success is still uncertain; the stronger contract is not evidence that the model will repair itself.

The alternative 4B Thinking model's second actual inference exhausted 1024 output tokens after 334.75 seconds. A 2048-token output allowance fits its recorded 1567-token input within 4096 context, but measured decoding implies approximately 615 seconds per round and a 720–900 second request deadline. That is a substantially slower next experiment. Do not misclassify the 4B result as unsupported tools.

Validation must capture the final forwarded generation request after any test wrapper, not describe the worker's pre-wrapper request as exact wire input. Preserve model/server identity, immutable worker image and harness hashes, actual schemas, every proposal/rejection and tool result, token/finish/timing metrics, operation identity/counter, and independent real output verification/retained-byte checks. Use a new job after the coherent build; no synthetic result may enter this physical run. Keep the existing actual 180-second command, outage/recovery, mandatory verification, artifact download and host-offline retained-byte requirements. The job's own wall limit bounds any correction loop; no automatic model fallback or command replay is permitted.
