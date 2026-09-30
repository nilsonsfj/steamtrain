# Local file locks

Project state writers and git worktree operations share an exclusive file lock.
PR landing uses the same mechanism with an explicit best-effort option: after its
acquisition budget expires, landing may continue with `locked: false` and must
still re-check GitHub's merge conditions.

Ownership is tied to a unique token and a process on the local host. A contender
can reclaim a lock only when that same-host process is confirmed dead. An old
heartbeat does not authorize removal of a live or unverifiable owner. This also
applies to the short coordinator used to serialize lock creation, recovery, and
release. Release waits for the coordinator; it never deletes a lock outside it.
The `staleMs` option remains the basis for heartbeat cadence, but no longer grants
permission to revoke an owner based on age.

Restart all processes using a lock directory together when upgrading this
ownership protocol; older versions do not follow these coordination rules.

Payloads are written completely before an atomic exclusive hard-link publishes
them, so a crash during writing cannot expose a partially written owner record.
The filesystem must support hard links between sibling files. Acquisition errors
on unsupported filesystems are surfaced; required state writers do not proceed
without their lock.

Recovery claims are immutable and tied to one coordinator incarnation. If a
recovering process dies, the next process claims a successor generation rather
than deleting the previous claim. These small files are retained only after
coordinator recovery, preventing delayed contenders from acquiring the same
recovery generation twice.

A malformed record or a record from another host remains unavailable for
automatic recovery. Stop every steamtrain process using that lock directory
before manually removing such records, retained recovery claims, or orphaned
`.owner.*` staging files. Removing them while a process is running invalidates
the ownership protocol. Normal same-host crashes recover automatically.
