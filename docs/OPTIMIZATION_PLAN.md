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
CSS. The production preview opens, and entering Map mode mounts the canvas
without browser console errors.

- Add an automated browser smoke path for import, annotation, node creation,
  save/restore, and source navigation when a CI browser runner is available.
  The current local browser check covers startup and first Map-mode mount.
- The graph view is now a separate 33 KB JavaScript chunk (9.3 KB gzip) and
  19 KB CSS chunk (3.6 KB gzip), loaded on first use. Production HTML still
  preloads the 793 KB Drawnix, 1.43 MB ELK, and 1.39 MB Mermaid vendor chunks;
  those dependencies remain on the startup path and must not be described as
  action-lazy yet.
- Compare the current unminified production output with Vite's JavaScript
  production minifier. Keep JavaScript minification enabled only if it reduces
  shipped assets, preserves deferred reader imports, and passes the
  existing test/build checks. Keep CSS minification disabled until the current
  CSS Module and vendored styles are compatible with Lightning CSS.
- Follow up on the production entry graph: the current entry statically imports
  large Drawnix, ELK, and Mermaid vendor chunks. Continue separating shared
  dependencies from the initial route before claiming those vendors are
  action-lazy.

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

### Batch 7: Source-Anchored Reader AI

Status: explain, summarize, and create-graph actions are implemented. Every
request still requires a review of the provider and exact passage. The result
dialog displays the source passage and can save the answer into its linked
annotation or create nested graph nodes under that annotation.

- The graph nodes retain the source annotation as their root, so the existing
  graph view can navigate back to the passage.
- Markdown headings and nested bullets are converted into up to three graph
  levels. Plain text falls back to one graph node.
- AI answers and generated graph nodes remain local until the user saves or
  saves the project; the app does not send additional document context.

### Batch 8: Encrypted Sync Protocol Foundation

Status: provider-independent encrypted revision and sync engine are implemented
and tested against an in-memory conditional-write provider. No network provider
or sync UI is enabled yet.

- AES-256-GCM encrypts the complete snapshot on the client. PBKDF2-SHA-256
  derives the encryption key from a user-supplied passphrase; the engine does
  not persist the passphrase or key.
- Revision metadata is authenticated, revisions are immutable, and head changes
  use compare-and-swap to avoid overwriting concurrent work.
- A divergent remote snapshot is preserved through the local adapter's
  conflict-copy contract; a remotely reset head never causes an automatic
  upload.
- A WebDAV or S3 adapter, credential storage, UI, and real-service behavior
  remain contingent on selecting and configuring a provider.

### Batch 9: Defer Graph View Code

Status: graph opening now dynamically imports the graph view. The annotation
source-navigation event waits for that import, while board highlighting checks
the active graph overlay in the DOM without importing graph code during startup.
Project-folder save actions and canvas-only viewport helpers are also kept out
of the reading-only dependency path.

- The production entry fell from 286 KB to 233 KB (uncompressed) after the
  graph view and board-only helpers left the initial dependency graph.
- Mermaid, ELK, and Drawnix vendor preloads remain a measured follow-up, so
  further module-boundary work is still needed for their transfer costs.

## Feature Designs

### Reader AI

Status: explain, summarize, and create-graph actions are implemented in the
floating reading toolbar. Every request requires confirmation after showing
provider, endpoint, model, and the exact excerpt. Results can be saved to the
linked annotation or inserted into its graph view.

- Reuse the existing provider configuration and AI client.
- Offer explicit actions for explain, summarize, and create-map-from-selection.
- Send only the selected passage and the user's chosen surrounding context.
- Show the destination/provider and the data being sent before the first use;
  never run requests in the background.
- Preserve a source anchor on generated notes so they can jump back to the
  passage.

Initial implementation scope: use the most recently highlighted passage. Send
only that passage, without surrounding document text. Show a confirmation with
the exact passage, provider, endpoint, and model for every request. Persist
answers only after the user chooses Save to annotation or Create graph.

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
- Sync protocol tests use only a local in-memory provider; no live cloud
  account, provider endpoint, or external credential has been configured.
