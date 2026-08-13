module keyAuthenticationMigrationSafety {
  import keyAuthenticationMigration(
    writerUsesKeyBound = true,
    enforceLegacyCutoff = true,
    enforceKeyBoundHistory = true,
    enforceKeyBoundBinding = true
  ).* from "./KeyAuthenticationMigration"
}

module keyAuthenticationMigrationBrokenWriter {
  import keyAuthenticationMigration(
    writerUsesKeyBound = false,
    enforceLegacyCutoff = true,
    enforceKeyBoundHistory = true,
    enforceKeyBoundBinding = true
  ).* from "./KeyAuthenticationMigration"
}

module keyAuthenticationMigrationBrokenCutoff {
  import keyAuthenticationMigration(
    writerUsesKeyBound = true,
    enforceLegacyCutoff = false,
    enforceKeyBoundHistory = true,
    enforceKeyBoundBinding = true
  ).* from "./KeyAuthenticationMigration"
}

module keyAuthenticationMigrationBrokenHistory {
  import keyAuthenticationMigration(
    writerUsesKeyBound = true,
    enforceLegacyCutoff = true,
    enforceKeyBoundHistory = false,
    enforceKeyBoundBinding = true
  ).* from "./KeyAuthenticationMigration"
}

module keyAuthenticationMigrationBrokenBinding {
  import keyAuthenticationMigration(
    writerUsesKeyBound = true,
    enforceLegacyCutoff = true,
    enforceKeyBoundHistory = true,
    enforceKeyBoundBinding = false
  ).* from "./KeyAuthenticationMigration"
}
