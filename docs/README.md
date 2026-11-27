# Documentation Index

## Purpose

This directory records OwnFlick's key design decisions, release changes, and implementation constraints to reduce repeated discussion and regressions in later iterations.

## Documents

- [中文信息流改造开发文档](中文信息流改造开发文档.md)：当前中文版本的需求、实现、随机 API 契约、验收结果与环境限制。此前的阶段文档保留为历史设计记录；当前入口与功能范围以本文档和项目 README 为准。
- [Releasing OwnFlick](releasing.md): local checks, publisher configuration, and the first release.
- [Web architecture](web-convergence-plan.md): current module boundaries, runtime constraints, and verification.
- [Phase 2 backend APIs](backend-api-phase2.md): independent likes/favorites, automatic legacy migration, folder browsing, and scoped feed contracts.
- [Phase 3 player controls](player-controls-phase3.md): draggable progress, gesture cancellation, persistent clean mode, and browser validation.
- [Phase 4 reactions and state feeds](reactions-phase4.md): independent like/favorite controls, idempotent double-tap likes, chronological state feeds, and concurrency handling.
- [Phase 5 folders and collection playback](folders-collections-phase5.md): hierarchical folder browsing, scoped sequential/random playback, collection progress, episode selection, browser verification, and container validation status.
- [Docker](docker.md): container image, volumes, permissions, and updates.
- [Android with Termux](android-termux.md): running OwnFlick on an Android phone.
- `docs/mixed-feed-design.md`: design and implementation notes for the mixed video and image Flow feed.
- `docs/flow-interaction-unification.md`: the shared interaction model for Flow, Library, and Favorites, including title entry points and asynchronous state rules.
- `docs/media-index-and-recommendation.md`: data flow and implementation boundaries for media indexing, safe synchronization, thumbnails, and local recommendations.
- `docs/openrouter-image-to-video-research.md`: OpenRouter image-to-video research, proof-of-concept flow, and future product constraints.
- `docs/release_notes.md`: release history and unreleased changes.

The design and research documents above retain their original language until they are translated in a dedicated documentation pass.
