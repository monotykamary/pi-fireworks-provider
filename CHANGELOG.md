# Changelog

## 1.7.5

- Pin Pi SDK development dependencies to 1.0.0 while retaining wildcard host peers.
- Verify real manifest loading, provider catalogs, startup/shutdown and native/bundled Pi hosts offline.
- Exercise real transport adapters with Unicode text, tool calls, empty responses, usage, request hooks and cancellation; no live provider calls.

## 1.7.4

- Validate against Pi 0.99.0, including an offline real-host package-loading probe.
- Declare imported host packages as wildcard peers and pin development dependencies to Pi 0.99.0.
- Treat unknown zero token limits as missing metadata using Pi's default limits.
