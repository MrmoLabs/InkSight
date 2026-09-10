# Changelog

All notable changes to InkSight are documented in this file. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Reader toolbar controls now wrap into a stable two-row layout when side panels leave the reader pane narrow, preventing title-bar icons from overlapping.

## [1.2.0] - 2026-09-09

### Added

- Added delayed full-title previews for truncated graph bubbles and in-bubble editing for node titles and complete AI questions.

### Changed

- Graph bubbles now use an explicit selected state: unselected bubbles can be dragged from any point or double-clicked to expand, while editing, scrolling, highlighting, node actions, and AI generation are available only after selection.
- AI questions are stored separately from display titles, remain synchronized until the title is customized, and can be edited before regenerating an answer.

### Fixed

- Opening graph view now forces the mind-map pane to a usable width instead of allowing compact split layouts to collapse its interactive viewport.
- Regeneration keeps the previous AI answer visible when a replacement request fails, dropped bubbles retain their new layout position, wheel input over a selected bubble scrolls its content without zooming the graph, graph selection/expansion and clickable parent-to-child text marks survive project reloads, and double-clicking an unselected bubble toggles its expanded state while keeping the node selected without triggering the text-selection extension prompt. Saving a project also updates the reload-recovery snapshot, and long project names no longer exceed the browser directory-picker ID limit.

## [1.1.0] - 2026-09-07

### Added

- Simplified Chinese and English localization across the application shell, settings, annotations, project flows, graph view, and Drawnix integration.
- Read, Capture, and Map workspace presets with dedicated notes and map panel states.
- Knowledge graph expansion from annotations, persistent graph nodes, and optional streaming AI conversations using graph context.
- Responsive desktop, tablet, and phone layouts with mobile navigation and project actions.
- Project home, recent projects, project-directory import/export, recovery snapshots, and outline/citation/notes exports.
- Windows GitHub Release automation that builds a ZIP archive and publishes its SHA-256 checksum.
- A Windows application icon derived from the InkSight logo.
- A bilingual privacy notice covering local storage, AI requests, and API credential handling.

### Changed

- Redesigned the interface around the Paper & Ink visual system, including multiple light and dark themes.
- Expanded canvas organization and automatic layout options for source, time, and loose arrangements.
- Updated Drawnix integration and maintenance documentation while keeping InkSight-specific behavior isolated.
- Raised the supported Node.js version to 22.12 or newer and refreshed application dependencies.
- Updated documentation to match the current project, privacy, deployment, and Windows packaging behavior.
- Enabled Electron `asar` packaging while keeping writable runtime data outside the application archive.

### Fixed

- Improved source-link recovery, document registration reconciliation, annotation deletion, project persistence, and mobile interactions.
- Added atomic local writes and a writable Electron user-data fallback for packaged installations.
- Protected Electron AI credentials with operating-system secure storage when available.
- Added trusted-device and session-only API key choices for the browser build, plus a dedicated key-clearing control.
- Kept Gemini API keys out of request URLs by sending them through the provider's authentication header.
- Disabled scripted EPUB content and rendered document-supplied names and loading errors as text to reduce injection risk.
- Hardened local file path handling, external link handling, HTML rendering, and AI endpoint validation.
- Stabilized deterministic GitHub Pages builds and expanded automated coverage for application and Electron workflows.

## [1.0.0] - 2026-01-06

- Initial public release.

[Unreleased]: https://github.com/MrmoLabs/InkSight/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/MrmoLabs/InkSight/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/MrmoLabs/InkSight/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/MrmoLabs/InkSight/releases/tag/v1.0.0
