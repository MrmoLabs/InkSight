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
- Test the encrypted, unavailable, migration, and clear-key paths.

### Batch 3: Shared Safe Rendering

Status: completed.

- Move the duplicated HTML escaping helper into a shared utility.
- Use it at the search, project-home, file-library, and recovery-workbench HTML
  string boundaries.
- Add tests for text and attribute contexts.

### Batch 4: Graph View Boundaries

- Separate graph AI request/state handling from the graph view's DOM and
  interaction controller.
- Keep rendering and selection behavior in the existing view.
- Preserve behavior with focused unit tests before extracting additional parts.

### Batch 5: End-to-End Coverage and Performance Evidence

- Add a browser-driven smoke path for import, annotation, node creation,
  save/restore, and source navigation when a supported browser runner is
  available in the build environment.
- Record initial-load and first-use chunk costs for Mermaid and ELK. Keep the
  current action-lazy loading if those chunks stay out of startup; split them
  further only when measured first-use latency warrants it.

## Feature Designs

### Reader AI

- Reuse the existing provider configuration and AI client.
- Offer explicit actions for explain, summarize, and create-map-from-selection.
- Send only the selected passage and the user's chosen surrounding context.
- Show the destination/provider and the data being sent before the first use;
  never run requests in the background.
- Preserve a source anchor on generated notes so they can jump back to the
  passage.

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
