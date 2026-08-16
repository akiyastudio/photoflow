# Process supervision

All application-owned child processes use `ProcessSupervisor` for lifecycle
state and structured logs. The supervisor records a stable process ID, runtime
kind, PID, generation, start/health timestamps, restart count, and last exit.

| Runtime | Policy |
| --- | --- |
| Python database and thumbnail protocol workers | restart unexpected exits up to three times with bounded backoff |
| Python import, conversion, backup and media jobs | supervised one-shot process; cancellation and timeout never restart the job |
| C# Shell thumbnail helper | restart unexpected exits; protocol timeouts recycle the process |
| C# recycle-bin and file-clipboard helpers | supervised one-shot process with caller timeout |
| Optional video component | startup health deadline, supervised session, no automatic restart because playback context is not replayable |

Protocol workers mark themselves healthy after receiving a valid protocol
response. Optional components mark healthy after their versioned `ready`
message. A health deadline or request timeout terminates the unhealthy process;
restartable workers use their bounded recovery policy, while stateful jobs fail
back to the owning workflow.

Lifecycle records use the existing application logger and the messages
`Managed process started`, `healthy`, `exited`, `restart scheduled`, `restart
limit reached`, and `stopped`. Every record includes `processId` and
`processKind`, so logs can be correlated across restarts without relying on a
PID.

Shutdown remains owner-aware: services first reject or finish their pending
requests, then stop their managed process. The application finally invokes
`stopAll` as a safety net. Intentional stops, cancellation, and application
shutdown never consume the restart budget.
