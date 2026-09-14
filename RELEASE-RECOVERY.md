# Release verification and recovery

Before upgrading a persistent Mirror installation, keep the previous image and
a database backup with its matching encryption key. The running database must
never be the target of a restore test.

## Database compatibility

The current schema version is **1**, stored in SQLite's `PRAGMA user_version`
and exposed as `storage.schemaVersion` by `/api/diagnostics`. Version 0 means
the historical unversioned SQLite schema. The baseline supports that schema,
including databases lacking `attachments_json`, `is_private`, or `is_branch`.
Existing encrypted sessions, messages, instructions, and upstream node IDs are
preserved. The historical `store.json` session importer remains supported.

Schema changes and the version advance commit in one transaction. An error
rolls back the entire upgrade. Reopening a current database does not replay the
migration. A database with a newer version is refused with a compatibility
error. Future migrations must be appended to `apps/server/src/schema.ts`;
released migrations must remain unchanged. Never change `user_version` by hand
to get past the compatibility check.

Older binaries predating this version check cannot enforce it. Although version
1 adopts the existing schema, downgrade compatibility is not promised: restore
the pre-upgrade backup into a new volume when returning to an older release.

## Local release checks

Run with Node 24 after installing dependencies:

```sh
npm ci
npm run typecheck
npm run coverage
npm run build
npm run storage:drill
npm run test:e2e
npm run manifest -- --check
```

The restore drill uses synthetic data under a new temporary directory and
deletes that directory when finished. It ignores the configured data directory
and replaces any configured storage key for its supplied-key case. It checks
SQLite integrity, session decryption, instructions, message content, upstream
conversation/parent identity, source preservation, overwrite refusal, and
wrong-key refusal in both key modes. It does not contact ChatGPT or prove live
continuation. CI runs it after the build. A dependent container job then builds
the same revision, repeats the drill inside the runtime image with networking
disabled, checks the embedded revision, and records the image ID and OCI label.

## Identify and verify a candidate image

Build from a committed, clean checkout. Set `MIRROR_BUILD_REVISION` to its full
commit SHA before `docker compose build mirror`; Compose forwards it as a build
argument. The resulting image includes an OCI revision label and the same
default revision in diagnostics. Unspecified revisions remain `development`.
Record the actual image ID, Node version, package-lock hash, source manifest,
and OpenAPI outputs with the candidate. A revision argument is a label supplied
by the builder, not proof that a dirty build matches that commit.

Before replacing the running service, run the candidate offline:

```sh
docker run --rm --network none --entrypoint node CANDIDATE_IMAGE scripts/restore-drill.mjs
```

Replace `CANDIDATE_IMAGE` with the verified image ID. This invocation mounts no
production volume. Maintenance scripts are included in the runtime image.
Mutable base-image tags and the absence of a publishing workflow mean current
builds are not yet claimed to be bit-for-bit reproducible releases.

## Backup and isolated restore

Compose stores data at `/home/node/.mirror` in its `mirror-data` named volume.
The volume's actual name includes the Compose project prefix. The separate
`mirror-warp` volume stores WARP state. Do not remove either volume during an
upgrade; in particular, do not use `docker compose down -v`.

The host maintenance command uses `.data` by default. It does not implicitly
operate on the Compose volume. Set `MIRROR_DATA_DIR` to the actual mounted data
directory when running maintenance in a container or against an offline copy.

1. Record the old image ID and stop the Mirror service before the offline
   upgrade procedure. WARP can remain running.
2. Run `node scripts/storage.mjs backup NEW_BACKUP_DIRECTORY` in an environment
   where the source volume is mounted and `MIRROR_DATA_DIR` points to it.
   Use a fresh backup destination outside that volume. The backup API includes
   committed WAL data; copying only an active `mirror.db` is not equivalent.
3. Protect the backup as private data. In generated-key mode it includes
   `master.key`. In supplied-key mode preserve the original `MIRROR_STORE_KEY`
   separately; it is deliberately not exported by the backup command.
4. Mount a separate, empty target volume and run
   `node scripts/storage.mjs restore BACKUP_DIRECTORY --offline` with
   `MIRROR_DATA_DIR` pointing to the target. Restore refuses an existing
   `mirror.db`. Start the candidate against that target with the matching key,
   then confirm diagnostics and expected conversation history.
5. After the offline checks pass, roll out the candidate using the intended
   data volume. Confirm WARP health, schema/build diagnostics, model discovery,
   and a disposable conversation through three turns using the returned
   history. Record this separately as live upstream evidence.

## Rollback

If startup or acceptance fails, stop the candidate and retain the failed
volume for diagnosis. Restore the pre-upgrade backup into another empty volume,
supply its matching key, and start the recorded previous image against that
volume. Verify WARP, diagnostics, model discovery, and a live continuation.
Do not overwrite the failed database or force a lower schema version.

The offline drill proves the backup/restore mechanism. A real Compose volume
restore with production-shaped data and authenticated continuation is a
separate release acceptance task.
