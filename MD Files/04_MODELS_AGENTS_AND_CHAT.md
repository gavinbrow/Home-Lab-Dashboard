# 04 — Models, Agent Profiles, and Chat

This is an implementation specification, not a report that the integrations have already been configured. Names and identifiers in examples are illustrative. Build the first-version requirements in this document before implementing the optional enhancements at the end.

## 1. Keep four independent selections visible

Place a persistent context bar above chat, jobs, editor, and terminal. Preserve it in narrow layouts as an expandable summary that still shows the execution computer and workspace.

| Selection | Meaning | Required display |
| --- | --- | --- |
| Model | The provider and exact model or loaded instance generating text | Provider label, exact model identifier, variant when known, inference location when configured, verified capabilities |
| Agent profile | The instructions, allowed tools, defaults, and limits controlling the agent | Profile name and version; effective permissions and limits accessible in one click |
| Execution computer | The enrolled computer that executes tools and commands | Machine name, stable machine ID, operating system, runner status, execution identity |
| Project workspace | The durable project data used by the run | Project name, workspace type, authoritative computer and path or volume, environment/container name when applicable |

Example: `Model: LM Studio / selected-model → Agent: Project Developer v3 → Execute: Linux-Worker → Files: Chemistry-Tools /srv/projects/chemistry-tools; runtime: project-17-env-4`. The inference server may be a different computer from Linux-Worker. Display that distinction; never infer execution placement from the model server.

Implementation steps:

1. Give each entity its own database identifier and selector. Do not encode all four in a single model name.
2. Let selecting a profile populate defaults only when the user has not already made an explicit selection. Highlight an applied default.
3. Bind each existing-folder or container workspace to its authoritative execution/storage computer. A machine change must select another compatible workspace or explicitly create a new one. Do not silently copy projects or remap Windows paths to Linux.
4. Allow plain chat with `Execution: None` and `Workspace: None`. An agent needing files or commands cannot start until compatible selections exist.
5. Resolve and validate all four selections on the server at submission. Return a preview of the effective context and permissions before the first run in a newly configured scope.
6. Snapshot provider/model identifier, provider configuration revision and resolved adapter/endpoint, profile version, execution target, workspace, instructions version, and generation settings into each job. Selector or provider-endpoint changes affect future jobs; they never silently retarget an existing job. Same-endpoint secret rotation follows an explicit credential-refresh policy.
7. Show the actual provider/model returned in each assistant response when available. Preserve requested and resolved identifiers if a provider maps aliases. Never silently fail over to a different provider or model.

## 2. Build provider adapters behind the backend

Use one internal interface and separate adapters for generic OpenAI-compatible endpoints, Ollama, LM Studio, and vLLM. The custom GVNB endpoint can be configured through the generic adapter. No API key belongs in this specification, a frontend environment variable, an exported project, or ordinary request logs.

The adapter interface should cover `discoverModels`, `streamChat`, `getCapabilities`, `getRuntimeState`, and optional `loadModel`, `unloadModel`, `downloadModel`, `getDownloadStatus`, `cancelRequest`, and `getMetrics`. Return `unsupported` for absent functions. Do not implement a guessed HTTP route because another provider happens to use it.

| Adapter | First-version inference and discovery | Management and runtime observations |
| --- | --- | --- |
| Generic OpenAI-compatible | `/v1/chat/completions`; `/v1/models` when supported; manual exact model ID if discovery is unavailable | Runtime residency and provider-wide load unknown unless a documented extension is explicitly configured |
| Ollama | Native `/api/chat` and `/api/tags`; validate installed API behavior | `/api/ps` for memory residency; tested load/unload behavior, model pull progress, supported model deletion under a separate permission |
| LM Studio | `/v1/chat/completions` for the dashboard-owned tool loop; discover through the native API when available | Current native v1 list/load/unload/download APIs, installed-version probe, loaded instance IDs and supported configuration |
| vLLM | OpenAI-compatible chat and models endpoints | Optional health/load/Prometheus metrics; no generic promise of arbitrary model download, swap, or unload |

These mappings are grounded in [Ollama chat](https://docs.ollama.com/api/chat), [model listing](https://docs.ollama.com/api/tags), [running models](https://docs.ollama.com/api/ps), [LM Studio API comparison](https://lmstudio.ai/docs/developer/rest), and [vLLM online serving](https://docs.vllm.ai/en/stable/serving/online_serving/). They must still be verified against the versions actually installed in the homelab.

For LM Studio, the current documentation distinguishes native `/api/v1/chat` from `/v1/chat/completions`: the native chat route offers integrated MCP and additional stream events, while the compatible chat-completions route supports custom tools. Use compatible chat for the dashboard agent and native management routes for residency/configuration. Do not transfer the tool loop into provider-managed MCP and thereby bypass dashboard authorization. [LM Studio endpoint comparison](https://lmstudio.ai/docs/developer/rest).

### Provider onboarding sequence

1. Enter display name, adapter type, backend-reachable URL, optional inference-machine link, credential reference, TLS trust settings, and local/remote routing classification.
2. Normalize URLs once. Distinguish an API root from a compatible `/v1` root so requests never become `/v1/v1/chat/completions`.
3. Test DNS, connection, TLS, authentication, discovery, and a short inference separately. Save actionable per-test errors without secrets.
4. Discover exact model identifiers; retain cached discovery with a timestamp during outages. Provide manual model registration for providers without discovery.
5. Run explicitly selected capability probes. Explain that an inference test can load a model and consume GPU memory; ordinary discovery must not trigger hidden inference. Record installed server version where discoverable, model variant/digest where exposed, probe version, time, and outcome.
6. Set the provider's concurrency and queue limits, request timeout, permitted management actions, and allowed profiles. Map aliases and multiple URLs for the same physical model server to a shared runtime/concurrency pool.
7. Save. Provider edits and credential rotation should not require frontend recompilation.

Allow explicitly enrolled private addresses because this is a homelab product. Prevent tool-supplied URLs, redirects, or model output from rewriting configured provider destinations. Validate TLS by default; support a configured private CA rather than a global certificate-check bypass.

## 3. Represent model state accurately

Use independent attributes instead of one overloaded green status badge.

| Attribute | Values and evidence |
| --- | --- |
| Catalog presence | Discovered, manually configured, removed, or stale cached entry |
| Provider reachability | Reachable, unreachable, authentication failed, or unknown |
| Availability | Ready to request, needs download, disabled, or unknown; provider behavior may load a model on demand |
| Residency | Loaded, unloaded, loading, unloading, or unknown; only use observed provider data |
| Activity | Dashboard active requests and queued requests; provider-wide counts shown separately when observable |
| Capability | Claimed, tested pass, tested fail, unsupported, unknown, or stale test |

Ollama `/api/ps` describes models currently in memory; it does not prove a model is generating at that moment. LM Studio's native model listing exposes `loaded_instances`; retain the instance identifier and effective context configuration. [Ollama running models](https://docs.ollama.com/api/ps), [LM Studio model listing](https://lmstudio.ai/docs/developer/rest/list).

Display `Loaded; 1 dashboard request; other clients unknown` when that is all the evidence supports. Do not show idle merely because this dashboard has no running jobs. A failed status poll makes the observation stale; it does not establish that a model was unloaded.

Favorites are per-user references to provider ID plus model ID. Preserve favorites across discovery refreshes, and mark missing models unavailable. Show quantization, context limit, and size only when provider metadata supplies them or an administrator explicitly labels them as configured values.

## 4. Test capabilities with harmless fixtures

Model names, architecture labels, and advertising are insufficient evidence of working tool use or image input. Persist capability results for the exact provider/model/configuration combination.

| Probe | Procedure | Passing evidence |
| --- | --- | --- |
| Basic chat | Ask for a short nonce-bearing response | Successful decoded response; requested/resolved model recorded |
| Streaming | Request enough output to observe incremental delivery | Valid incremental events before completion, correct final assembly |
| Tool calling | Offer a harmless `echo_nonce` tool, execute it in the test harness, return its result, ask for final answer | Valid arguments, tool result consumed, correct nonce in answer |
| Structured output | Request a tiny JSON object with required fields and types | Output passes the configured JSON Schema |
| Image input | Send small synthetic images with distinguishable content | Request accepted and expected image content recognized; label this a smoke test |
| Cancellation | Start a bounded test generation and request stop | Client stop observed; provider stop separately marked confirmed or unconfirmed |

Store failures as failures, not as permission errors to be worked around. A text-only model remains usable for ordinary chat but unavailable to profiles requiring reliable tool calling. A single passing test establishes integration compatibility, not broad reasoning reliability. Re-test after a model replacement, server upgrade, chat-template change, or changed tool parser.

vLLM tool use depends on server configuration, compatible model behavior, and the selected tool-call parser; probe the deployed server rather than assuming compatible HTTP endpoints imply working tools. [vLLM serve tool-parser options](https://docs.vllm.ai/en/stable/cli/serve/).

## 5. Implement the chat interface

Use familiar Open WebUI interaction patterns: conversation sidebar, searchable history, model picker, streaming assistant messages, attachments, code blocks, markdown, regenerate, stop, rename, and export. Build an original interface around this system's machine/workspace context and permissions. A full Open WebUI fork or iframe is not required.

First-version steps:

1. Persist conversations, messages, attachments, message revisions, selected context, and generation parameters in PostgreSQL and durable file storage.
2. Submit messages through the backend with an idempotency key. A retry from a reconnecting browser returns the existing message/job.
3. Let the server own the provider request. Persist ordered stream events in bounded batches before publishing them to clients.
4. Reconnect using the last persisted event sequence. Reload message state and then resume tailing; never resubmit the user prompt automatically.
5. Render tool requests, tool results, status, logs, changed files, and generated artifacts as distinct items in the conversation timeline.
6. Keep partial responses when a provider or worker fails. Label them interrupted and offer a deliberate continuation or retry.
7. Scope Stop: `Stop response` stops local delivery and requests provider inference cancellation; show provider termination as confirmed or unconfirmed separately. `Cancel agent job` prevents further steps and also requests cancellation of active host tools. Host process termination requires supervisor acknowledgement; inference has no host-runner acknowledgement. Preserve uncertain provider reservations until reconciliation, even if browser delivery has stopped.
8. Store original attachments in the selected workspace or an explicitly identified chat-attachment store. A local file path is never sufficient input to a remote provider: the backend must intentionally send allowed file content.
9. Treat remote-provider selection as permission to send the chosen chat inputs, subject to project policy. Show a persistent remote-processing label, and allow projects to prohibit remote providers. A local endpoint can itself route to cloud models; record configured routing evidence rather than classifying solely by hostname.
10. Sanitize rendered markdown, disable executable HTML by default, bound preview sizes, and keep generated HTML outside the authenticated application's origin.

Ordinary code blocks are text. Only a validated structured tool call may request execution, and only the backend can authorize it. A message saying “I ran the tests” is not verification evidence unless a recorded tool result supports it.

## 6. Define reusable, versioned agent profiles

Create, duplicate, edit, archive, and select profiles. Retain old immutable revisions for job history. Seed examples can include `Read-Only Inspector`, `Project Developer`, and `Machine Operator`; example profiles start with no live-machine grants until configured.

Required profile fields:

- Name, description, instructions, default provider/model, optional allowed model set, required capabilities, and version.
- Allowed tools and typed tool options: read/write files, apply patch, run command, inspect metrics, read service health, and explicitly granted service/container actions.
- Permitted stable machine IDs and workspace IDs or administratively enrolled folder roots.
- Command execution identity, shell selection policy, network permissions, permitted secret references, and remote-provider policy.
- Maximum runtime, tool calls, command duration, output size, generated-file size, concurrent jobs, and token/output budgets.
- Default environment template or workspace preference when available, checkpoint policy, and required verification commands or verification expectations.

Example defaults are a 30-minute job, 60 tool calls, a five-minute per-command timeout, and one active job per workspace. These are configurable starting values, not universal hardware assumptions. Clearly surface which limit stopped a run.

Effective access is the intersection of authenticated-user permissions, machine policy, workspace policy, profile permissions, and the run's approved scope. Profiles cannot grant powers that the machine agent or operating-system identity does not possess. Project instructions can influence task behavior but cannot change backend permissions.

Retain authorization for routine actions inside the configured scope. Do not ask again for every file edit, test, or command already permitted. A new machine, out-of-scope folder, privilege increase, destructive project deletion, or newly requested external destination is a scope change. Show the concrete proposed change when a decision is needed. Revocations take effect for future tool dispatches even if a run originally captured broader permissions.

## 7. Build a durable, dashboard-owned agent loop

The API accepts a task; a worker runs it independently of browser connections. Use the common PostgreSQL job/event machinery and host runner ledger. The controller is not a request handler waiting for a browser tab to remain open.

Implementation order:

1. Resolve context, effective permissions, profile revision, and project instructions. Acquire the durable workspace writer lock before capturing initial file/checkpoint state. Orchestration lease expiry never releases an unresolved writer lock; document 05 defines reconciliation.
2. Persist the run and first inference step before starting provider I/O. Keep each step's request metadata and context references.
3. Assemble model context from the task, instructions, conversation, selected files, and recorded tool results. Apply context limits visibly; record summaries and omitted content rather than silently dropping instructions.
4. Validate returned tool names and arguments against schemas. Enforce permission and resource checks again at dispatch time.
5. Persist a unique tool-call record before sending it to the host runner. Use a stable operation ID for retries and reconciliation.
6. The runner records acceptance durably, executes using the authorized identity and workspace, spools logs, and reports exit status and artifact manifests.
7. Record changes and verification results before continuing the model loop. Return bounded tool results, linking full logs rather than flooding the prompt.
8. Repeat until a final answer, cancellation, unrecoverable error, or configured limit. Save a factual result summary and final checkpoint manifest.

Streamed, incomplete tool arguments are never executable. If a provider stream dies, save the partial assistant turn and mark the inference step interrupted. Reconcile all previously dispatched tools before allowing any continuation. Resume from a known persisted boundary; do not claim that an upstream HTTP generation can always resume after a backend crash.

A lost acknowledgement must not rerun a filesystem mutation or shell command. Query the runner ledger using the original operation ID. If execution outcome cannot be established, mark the step interrupted with unknown outcome for review. Exactly-once side effects across arbitrary remote commands cannot be guaranteed; preserving the ambiguity is safer than blind replay.

## 8. Record changes and verification as first-class results

Each tool execution records actor, job/step IDs, model/profile revisions, target machine, workspace, execution identity, approved scope, command/arguments with secret handling, working directory, timestamps, exit code, cancellation outcome, and observed affected systems. Mark effects outside available observation as unknown rather than claiming complete system-wide visibility.

For file tools, capture before/after hashes and recoverable prior bytes before writing. For shell tools, compare project snapshots and file manifests before and after the command, including untracked files; a shell can modify files without using `write_file`. Git diffs are useful for tracked text but are insufficient as the sole backup of generated binaries, ignored outputs, or pre-existing untracked files.

Show text diffs, added/deleted files, binary size/hash changes, and checkpoint restoration options. Distinguish known agent changes from detected outside edits; where attribution is ambiguous, label it unconfirmed. Use one durable dashboard writer lock per workspace in v1; warn when external processes change files, and require reconciliation rather than overwriting them.

Verification records contain the actual command or check, target, environment, time, exit status, and captured result. A zero exit code confirms that command succeeded; it does not establish that every requested behavior works. Final agent summaries should link the executed checks and state what remains unverified. Machine-wide actions can be audited, but project checkpoints do not automatically undo service restarts, package installations, or changes outside the project.

## 9. Concurrency, management jobs, and performance

Start with explicit limits: one active request per provider/runtime pool, one mutating agent run per workspace, configurable per-machine command slots, and bounded queues. Multiple provider entries or URLs pointing to the same server share a runtime pool so aliases cannot bypass limits. Preserve separate endpoint limits where appropriate. Permit administrators to raise limits after testing. Acquire/release slots through durable leases; browser closure does not release them, and a worker crash triggers reconciliation rather than immediate duplicate dispatch.

Model load/unload/download operations are jobs with progress, timeouts, cancellation where supported, and history. Unloading a model with active dashboard requests waits or requires a deliberate force action. Unknown external clients must remain visible as a limitation. A failed cancellation must not falsely display that a server stopped downloading or generating.

Ollama management behavior and concurrency settings must be matched to the deployed version; LM Studio load requests can return effective load settings and load time. [Ollama FAQ](https://docs.ollama.com/faq), [LM Studio load API](https://lmstudio.ai/docs/developer/rest/load).

Store both raw provider measurements and normalized fields with their units and provenance:

| Measurement | Definition and limitation |
| --- | --- |
| Dashboard queue time | Dispatch-ready time minus submission time; separate machine and provider waits |
| Time to first content | Backend request start to first content event; includes network/provider effects |
| Model load time | Provider-reported load duration, or unavailable |
| Prompt-processing rate | Uncached prompt tokens divided by actual prompt-evaluation seconds when both are available |
| Decode rate | Provider output-token count divided by provider generation seconds when available |
| End-to-end rate | Output tokens divided by backend wall time, explicitly labeled; never call this pure decode speed |
| Usage | Input/output tokens, cached tokens, finish reason, context configuration, model variant, and source |

Ollama reports timing fields in nanoseconds and supplies usage in its final stream chunk. Convert to seconds. Where the installed schema reports total input tokens plus cached tokens and uncached-evaluation duration, use `(prompt_eval_count - prompt_eval_cached_count) / (prompt_eval_duration / 1e9)`; record unavailable cache counts and version-specific semantics rather than assuming zero. Decode rate is `eval_count / (eval_duration / 1e9)` when duration is positive. [Ollama usage](https://docs.ollama.com/api/usage).

Do not count SSE chunks as tokens, calculate prompt throughput from time to first token, or invent missing timings. vLLM's Prometheus metrics can supplement request observations, but server-wide histograms and counters are not individual-request measurements. [vLLM production metrics](https://docs.vllm.ai/en/stable/usage/metrics/).

For optional benchmark actions, warm the selected model first, verify residency where observable, record load/cache state, run several fixed workloads, and separate prompt-processing and decode results. Save context length, output length, quantization, hardware, concurrency, and cached-prefix conditions so comparisons are meaningful.

## 10. Acceptance criteria on real configured providers and computers

The test report must use actual enrolled machines and configured providers, with sanitized identifiers. Fixtures establish repeatable inputs; they must not impersonate live telemetry.

1. **Selection independence:** run inference on one computer and a tool on another. The context bar, logs, output manifest, and resulting file location agree. Changing the selected model does not change the execution target.
2. **Scope enforcement:** a profile authorized for one workspace can edit there without repeated prompts; an attempted read/write outside its enrolled roots and an unauthorized service action fail server-side and runner-side.
3. **Provider behavior:** discover and stream using at least one real local provider. Also configure the user's actual compatible endpoint when available. Record unsupported management actions as unavailable. Do not declare an unconfigured adapter validated.
4. **Capability failure:** a model failing tool-use tests remains usable for text chat but cannot start a tool-required profile; an image-incompatible model gives a clear preflight error.
5. **Durability:** start an agent that runs a timed command and creates an output, close all browser tabs, and reconnect after completion. The same job, operation IDs, logs, and file appear; a sentinel proves the command executed once.
6. **Failure recovery:** interrupt the provider stream or restart its worker after a recorded tool dispatch. The UI shows the truthful partial/interrupted state, and recovery does not repeat the command.
7. **Concurrency:** submit more requests than the configured limit. Excess jobs wait visibly; cancellation removes an undispatched job; reconnecting does not consume extra slots.
8. **Audit and checkpoints:** edit tracked text and an untracked/binary artifact, inspect recorded changes, and restore a checkpoint without losing unrelated later work.
9. **Persistence:** replace the execution container and verify the generated output hashes and downloadable artifact references remain intact; the same profile can continue using the persistent workspace.
10. **Secrets and metrics:** inspect frontend assets and ordinary logs for credential leakage. Confirm unknown residency and unavailable timings remain unknown, and warm/cold observations are labeled.

## 11. Later phases

After the first-version gates pass, add additional provider adapters, richer model benchmark reports, optional document retrieval, configurable environment templates, isolated web previews, schedules, alerts, and resource-aware placement. Add external agent-framework or CLI adapters only behind the same authorization, job ledger, cancellation, and file-audit contracts.

Multi-agent collaboration requires separate worktrees or isolated workspaces, explicit task ownership, shared budget limits, conflict detection, reviewable merges, and attribution by agent. Do not let multiple agents write the same project concurrently merely because the model server supports parallel inference.

## Primary documentation checked

- [Ollama API introduction](https://docs.ollama.com/api/introduction), [chat](https://docs.ollama.com/api/chat), [catalog](https://docs.ollama.com/api/tags), [loaded models](https://docs.ollama.com/api/ps), [usage](https://docs.ollama.com/api/usage), [FAQ](https://docs.ollama.com/faq).
- [LM Studio native API and comparison](https://lmstudio.ai/docs/developer/rest), [model listing](https://lmstudio.ai/docs/developer/rest/list), [load model](https://lmstudio.ai/docs/developer/rest/load), [custom tools](https://lmstudio.ai/docs/developer/openai-compat/tools).
- [vLLM online serving](https://docs.vllm.ai/en/stable/serving/online_serving/), [server options](https://docs.vllm.ai/en/stable/cli/serve/), [production metrics](https://docs.vllm.ai/en/stable/usage/metrics/).
