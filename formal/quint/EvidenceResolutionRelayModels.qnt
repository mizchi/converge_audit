module evidenceResolutionRelaySafety {
  import evidenceResolutionRelay(
    enforcePollAuthentication = true,
    persistBeforePublish = true,
    persistRetrySchedule = true,
    enforceAttemptFence = true,
  ).* from "./EvidenceResolutionRelay"
}

module evidenceResolutionRelayBrokenPollAuthentication {
  import evidenceResolutionRelay(
    enforcePollAuthentication = false,
    persistBeforePublish = true,
    persistRetrySchedule = true,
    enforceAttemptFence = true,
  ).* from "./EvidenceResolutionRelay"
}

module evidenceResolutionRelayBrokenPendingDurability {
  import evidenceResolutionRelay(
    enforcePollAuthentication = true,
    persistBeforePublish = false,
    persistRetrySchedule = true,
    enforceAttemptFence = true,
  ).* from "./EvidenceResolutionRelay"
}

module evidenceResolutionRelayBrokenRetryDurability {
  import evidenceResolutionRelay(
    enforcePollAuthentication = true,
    persistBeforePublish = true,
    persistRetrySchedule = false,
    enforceAttemptFence = true,
  ).* from "./EvidenceResolutionRelay"
}

module evidenceResolutionRelayBrokenAttemptFence {
  import evidenceResolutionRelay(
    enforcePollAuthentication = true,
    persistBeforePublish = true,
    persistRetrySchedule = true,
    enforceAttemptFence = false,
  ).* from "./EvidenceResolutionRelay"
}
