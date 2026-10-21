# Frontend implementation plan

The frontend owns views, temporary editor state, selectors and authenticated subscriptions. The API owns authorization, run resolution and authoritative resource state. No sample telemetry or fallback inventory is used.

## Screen behavior

- Overview: inventory counts from successful responses; independent dependency failures; no invented health percentage.
- Machines: capability-specific configuration/health/reason/time, current and history readings retaining unavailable values, visible unavailable remote controls.
- Chat & Agents: independent model, immutable profile revision, execution machine and workspace selectors; preflight returns server-resolved locations. Submission uses an explicit idempotency key. Reattachment never resubmits a task.
- Projects: actual storage location, root-relative listing, bounded text editing, conditional saves and conflict comparison, authenticated downloads. Lifecycle verbs remain separate.
- Jobs: actual state/reason and server timestamps, current immutable context, durable ordered events with event-ID deduplication and replay cursor, cancellation remains pending until the server confirms.
- Models: catalog availability, residency, dashboard activity and capability evidence remain separate; no inference of external activity.
- Activity: retained audit data; errors never become empty history.
- Settings: providers and versioned profiles; saved credential values are never populated into a form or local browser storage.

## Interaction and accessibility

Use semantic navigation, headings, forms and tables; explicit labels, visible keyboard focus, status text in addition to color, inline validation and live status announcements. Mobile navigation remains operable. Control availability includes a readable reason adjacent to the disabled action.

## Verification gate

Build and typecheck the integrated client. Smoke authentication, navigation, truthful empty/error states, selection independence, job attachment, and conflict handling when API/runtime access is available. Real-machine T01–T23 remain distinct from local UI checks.
