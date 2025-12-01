# Changelog

## [2.0.0] - 2025-11-25
### Added
- Export `DynamicProxy` class (previous inline dynamic proxy logic now encapsulated) for clearer lifecycle control.
- New navigation helper export `agentConnectGoTo` (function previously accessible as `agentConnect`).
- Barrel exports now include `DynamicProxy`, `startDynamicProxy`, `agentConnectListener`, and `agentConnectGoTo` explicitly.

### Changed
- Refactored codebase: navigation/retry logic moved to `src/goto.ts`; dynamic proxy implementation moved to `src/dynamicProxy.ts`; index simplified to re-exports.
- Updated README with distinct sections for `agentConnectGoTo`, `DynamicProxy`, and `agentConnectListener`.

### Deprecated
- `agentConnect` (alias of `agentConnectGoTo`) retained for backwards compatibility; will be marked for removal in a future major release. Prefer migrating to `agentConnectGoTo`.


## [1.2.0] - 2025-11-20
### Changed
- Rename `ALUVIA_API_KEY` to `ALUVIA_TOKEN`


## [1.1.0] - 2025-11-12
### Added
- Add session ID to proxy credentials
- Stop dynamic proxy when browser is closed

### Changed
- Rename retryWithProxy to agentConnect
- Remove old restart browser code


## [1.0.0] - 2025-11-07
### Added
- Initial release
