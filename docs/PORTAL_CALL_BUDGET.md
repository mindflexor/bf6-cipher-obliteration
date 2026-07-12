# Portal frame-call budget

Production code calls `mod.*` directly. There is no runtime governor, call wrapper, reservation system, or ModSim dependency.

The mode targets at most 400 scripted Portal calls in a server frame, leaving 99 calls below Portal's 500-call abort boundary for coincident engine events. Expensive work is spread by the subsystem that owns it; overdue work never catches up in a burst.

| Lane or transition | Maximum work admitted per tick | Measured 8v8 peak |
| --- | ---: | ---: |
| Module/UI declaration import | Static initialization | 395 |
| Immediate game-mode start | Prematch shell and safe world shutdown | 347 |
| Player join burst | Minimal event capture; deferred bootstrap | 336 |
| Startup | One anchor or one player operation | 132 |
| All-ready events | Minimal ready-state updates | 248 |
| Ready-to-live | One phase stage, player operation, or objective operation | 334 |
| Scheduled engine callback | One callback; the owning phase yields for that frame | Below 400 |
| Cold live HUD | Cleanup, build, bind, objective, and deploy-timer stages on separate ticks | Below 400 |
| Live UI and scoreboard | One player per subsystem cursor | Below 400 |
| Postmatch | One player, one card build, or one reveal substep | 390 |

`npm run audit:mod-calls` reports direct engine calls nested in loops, fan-outs, and scheduled callbacks so new heavy paths can be reviewed. `npm run test:modsim:budget` runs the bundled mode against the vendored, unsupported ModSim harness with 16 players and fails any measured frame above 400 or at Portal's 500-call limit.

The ModSim result is an offline regression measurement, not a runtime admission mechanism. Real-server profiling should still be repeated when authored world content or Portal engine behavior changes.
