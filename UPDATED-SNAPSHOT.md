# Reliability update

The current source is the Git commit identified by the generated SHA256 manifest.
Node 24 is required. CI installs from the lockfile, type-checks, runs unit/integration
and mocked browser tests, builds production assets, and verifies the manifest.

This update covers pagination, stream completion/error handling, coherent saved
conversation state, session revision checks, authenticated local controls,
memory-only one-shot turns, storage maintenance, explicit unsupported Work Mode
reporting, and modular browser integration without Mirror-managed telemetry init.

Tests use temporary local storage and synthetic upstream responses. They do not
validate live ChatGPT protocol compatibility or prove account entitlement to a model.
