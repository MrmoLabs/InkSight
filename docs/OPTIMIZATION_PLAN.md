# InkSight Optimization Plan

This plan keeps the local-first product model and prioritizes changes that reduce
security risk, regression risk, and maintenance cost before adding new service
dependencies.

## Goals

1. Never write an API key in clear text from the Electron app.
2. Keep user-authored document and note text inert when rendering it as HTML.
3. Verify the reading-to-note-to-recovery workflow across module boundaries.
4. Reduce the maintenance cost of the graph view without changing its behavior.
5. Measure startup and first-use costs before changing existing lazy-loading.
6. Design reader AI and cloud sync around explicit user consent and local data
   ownership.

## Implementation Batches

### Batch 1: Workspace Search Rendering

Status: completed in `f9bdc9f`.

- Escape untrusted result values used in text and attributes.
- Add a regression test for markup and attribute injection.

### Batch 2: AI Credential Storage

Status: completed.

- Require Electron `safeStorage` encryption before persisting a non-empty API
  key.
- Keep an entered key available for the current session when encryption is not
  available; show a clear settings hint that the key cannot be safely saved.
- Preserve non-secret provider settings and allow clearing an existing key.
- Migrate legacy plaintext configuration to encrypted storage when OS
  encryption becomes available again.
- Test the encrypted, unavailable, migration, and clear-key paths.

### Batch 3: Shared Safe Rendering

Status: completed.

- Move the duplicated HTML escaping helper into a shared utility.
- Use it at the search, project-home, file-library, and recovery-workbench HTML
  string boundaries.
- Add tests for text and attribute contexts.

### Batch 4: Graph View Boundaries

Status: completed.

- Separate graph AI request/state handling from the graph view's DOM and
  interaction controller.
- Keep rendering and selection behavior in the existing view.
- Preserve behavior with focused unit tests before extracting additional parts.

### Batch 5: End-to-End Coverage and Performance Evidence

Status: JavaScript production minification completed. The local production
build shrank from 14.57 MB to 8.65 MB (40.6%). CSS minification remains off
because Lightning CSS rejects existing `:export` blocks and malformed vendored
CSS. The test suite passes, and the production preview opens successfully.

- Add a browser-driven smoke path for import, annotation, node creation,
  save/restore, and source navigation when a supported browser runner is
  available in the build environment.
- Record initial-load and first-use chunk costs for Mermaid and ELK. Keep the
  current action-lazy loading if those chunks stay out of startup; split them
  further only when measured first-use latency warrants it.
- Compare the current unminified production output with Vite's JavaScript
  production minifier. Keep JavaScript minification enabled only if it reduces
  shipped assets, preserves deferred reader imports, and passes the
  existing test/build checks. Keep CSS minification disabled until the current
  CSS Module and vendored styles are compatible with Lightning CSS.
- Follow up on the production entry graph: the current entry statically imports
  the Mermaid and Drawnix vendor chunks even though their main UI is deferred.
  Separate dependencies shared with the initial route from the conversion and
  graph-only code before claiming those vendors are action-lazy.

### Batch 6: Defer Canvas Mounting

Status: implemented with a shared retryable lazy initializer. The canvas is no
longer instantiated during application bootstrap; it loads on the first Map
mode transition or when a save/open operation needs a live board. Restore
payloads are queued until the canvas becomes ready, so the reading-only boot
can preserve map data without mounting the canvas first.

Design: do not instantiate the Drawnix canvas during application bootstrap.
Load and mount it on the first transition to Map mode, keep one shared
initialization promise, and allow retry after a failed load. This keeps the
reading-only startup free of canvas mount work without changing the user's
saved map data or the mode-switch behavior.

## Feature Designs

### Reader AI

Status: explain and summarize actions implemented in the floating reading
toolbar. Every request requires confirmation after showing provider, endpoint,
model, and the exact excerpt. Results remain temporary in a text dialog.

- Reuse the existing provider configuration and AI client.
- Offer explicit actions for explain, summarize, and create-map-from-selection.
- Send only the selected passage and the user's chosen surrounding context.
- Show the destination/provider and the data being sent before the first use;
  never run requests in the background.
- Preserve a source anchor on generated notes so they can jump back to the
  passage.

Initial implementation scope: provide explain and summarize actions for the
most recently selected/highlighted passage. Send only that passage, without
surrounding document text. Show a confirmation with the exact passage,
provider, endpoint, and model for every request. Keep answers temporary in the
result dialog; defer map creation and saved AI notes until their source anchor
and graph insertion behavior can be implemented together.

### Multi-Device Sync

- Keep sync opt-in and place transport behind a provider interface rather than
  coupling project persistence to WebDAV or S3 APIs.
- Treat a project snapshot and its referenced documents/assets as one revision.
- Use immutable remote revisions and a local revision cursor. When a remote
  revision and local edits diverge, create a recoverable conflict copy instead
  of silently overwriting either side.
- Encrypt private project contents on the client before upload; credentials and
  keys stay in the platform's protected credential store where available.
- Prototype against one provider first. Select WebDAV or S3 after validating
  authentication, conditional writes, versioning, and delete semantics.

## Completion Checks

- Each implementation batch gets its own commit and targeted tests.
- Full Vitest and production build pass after cross-cutting changes.
- Browser behavior is checked for changed user-facing flows when the local
  browser runner is available.
- No feature sends local document content to a provider without a direct user
  action.
