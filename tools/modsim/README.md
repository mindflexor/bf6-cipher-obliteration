# Vendored ModSim

This directory contains the unsupported ModSim source supplied with Portal SDK 1.3.3 from
`unsupported/modsim.zip`. It is vendored for deterministic Cipher Obliteration profiling, not as
a supported or authoritative implementation of the Portal runtime.

Local compatibility changes are intentionally small:

- simulation cadence is 30 Hz;
- `StepFrames(n)` advances an exact number of frames without a real-time delay;
- the budget harness supplies missing APIs (including current UI, Bomb-proxy, mandown, and
  world-object calls) through a compatibility Proxy instead of pretending ModSim implements them.

The production mode never imports ModSim.
