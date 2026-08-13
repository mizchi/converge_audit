module keyAuthenticationMigrationTests {
  import keyAuthenticationMigration(
    writerUsesKeyBound = true,
    enforceLegacyCutoff = true,
    enforceKeyBoundHistory = true,
    enforceKeyBoundBinding = true
  ).* from "./KeyAuthenticationMigration"

  run legacyReadsOnlyBeforeCutoff =
    init
      .then(receive(LegacyV1, false, false))
      .then(advanceToCutoff)
      .then(receive(LegacyV1, false, false).fail())

  run keyBoundReadsAcrossCutoffWithHistory =
    init
      .then(advanceToCutoff)
      .then(write)
      .then(receive(KeyBoundV2, true, true))
      .expect(and {
        state.lastWriterUsedKeyBound,
        state.lastAcceptedKeyBoundValid,
      })

  run keyBoundWithoutHistoryIsRejected =
    init.then(receive(KeyBoundV2, false, true).fail())

  run keyBoundWithRetargetedBindingIsRejected =
    init.then(receive(KeyBoundV2, true, false).fail())
}
