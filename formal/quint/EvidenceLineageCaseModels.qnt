// Healthy and deliberately broken evidence-to-decision configurations.
module evidenceLineageCaseSafety {
  import evidenceLineageCase(
    enforceHoldAuthentication = true,
    enforceHoldBinding = true,
    enforceCertificateAuthentication = true,
    enforceDecisionBinding = true,
    enforceDismissalAuthentication = true,
    enforceDismissalBinding = true,
    mutateAssetOnCaseOpen = false,
    mutateAssetOnDismissal = false,
    enforceSourceAuthentication = true,
    enforceSourceBinding = true,
    enforceSourceCursor = true,
    resolveHoldOnCaseClose = false
  ).* from "./EvidenceLineageCase"
}

module evidenceLineageCaseBrokenHoldAuthentication {
  import evidenceLineageCase(
    enforceHoldAuthentication = false,
    enforceHoldBinding = true,
    enforceCertificateAuthentication = true,
    enforceDecisionBinding = true,
    enforceDismissalAuthentication = true,
    enforceDismissalBinding = true,
    mutateAssetOnCaseOpen = false,
    mutateAssetOnDismissal = false,
    enforceSourceAuthentication = true,
    enforceSourceBinding = true,
    enforceSourceCursor = true,
    resolveHoldOnCaseClose = false
  ).* from "./EvidenceLineageCase"
}

module evidenceLineageCaseBrokenHoldBinding {
  import evidenceLineageCase(
    enforceHoldAuthentication = true,
    enforceHoldBinding = false,
    enforceCertificateAuthentication = true,
    enforceDecisionBinding = true,
    enforceDismissalAuthentication = true,
    enforceDismissalBinding = true,
    mutateAssetOnCaseOpen = false,
    mutateAssetOnDismissal = false,
    enforceSourceAuthentication = true,
    enforceSourceBinding = true,
    enforceSourceCursor = true,
    resolveHoldOnCaseClose = false
  ).* from "./EvidenceLineageCase"
}

module evidenceLineageCaseBrokenOpenMutation {
  import evidenceLineageCase(
    enforceHoldAuthentication = true,
    enforceHoldBinding = true,
    enforceCertificateAuthentication = true,
    enforceDecisionBinding = true,
    enforceDismissalAuthentication = true,
    enforceDismissalBinding = true,
    mutateAssetOnCaseOpen = true,
    mutateAssetOnDismissal = false,
    enforceSourceAuthentication = true,
    enforceSourceBinding = true,
    enforceSourceCursor = true,
    resolveHoldOnCaseClose = false
  ).* from "./EvidenceLineageCase"
}

module evidenceLineageCaseBrokenCertificateAuthentication {
  import evidenceLineageCase(
    enforceHoldAuthentication = true,
    enforceHoldBinding = true,
    enforceCertificateAuthentication = false,
    enforceDecisionBinding = true,
    enforceDismissalAuthentication = true,
    enforceDismissalBinding = true,
    mutateAssetOnCaseOpen = false,
    mutateAssetOnDismissal = false,
    enforceSourceAuthentication = true,
    enforceSourceBinding = true,
    enforceSourceCursor = true,
    resolveHoldOnCaseClose = false
  ).* from "./EvidenceLineageCase"
}

module evidenceLineageCaseBrokenDecisionBinding {
  import evidenceLineageCase(
    enforceHoldAuthentication = true,
    enforceHoldBinding = true,
    enforceCertificateAuthentication = true,
    enforceDecisionBinding = false,
    enforceDismissalAuthentication = true,
    enforceDismissalBinding = true,
    mutateAssetOnCaseOpen = false,
    mutateAssetOnDismissal = false,
    enforceSourceAuthentication = true,
    enforceSourceBinding = true,
    enforceSourceCursor = true,
    resolveHoldOnCaseClose = false
  ).* from "./EvidenceLineageCase"
}

module evidenceLineageCaseBrokenDismissalAuthentication {
  import evidenceLineageCase(
    enforceHoldAuthentication = true,
    enforceHoldBinding = true,
    enforceCertificateAuthentication = true,
    enforceDecisionBinding = true,
    enforceDismissalAuthentication = false,
    enforceDismissalBinding = true,
    mutateAssetOnCaseOpen = false,
    mutateAssetOnDismissal = false,
    enforceSourceAuthentication = true,
    enforceSourceBinding = true,
    enforceSourceCursor = true,
    resolveHoldOnCaseClose = false
  ).* from "./EvidenceLineageCase"
}

module evidenceLineageCaseBrokenDismissalBinding {
  import evidenceLineageCase(
    enforceHoldAuthentication = true,
    enforceHoldBinding = true,
    enforceCertificateAuthentication = true,
    enforceDecisionBinding = true,
    enforceDismissalAuthentication = true,
    enforceDismissalBinding = false,
    mutateAssetOnCaseOpen = false,
    mutateAssetOnDismissal = false,
    enforceSourceAuthentication = true,
    enforceSourceBinding = true,
    enforceSourceCursor = true,
    resolveHoldOnCaseClose = false
  ).* from "./EvidenceLineageCase"
}

module evidenceLineageCaseBrokenDismissalMutation {
  import evidenceLineageCase(
    enforceHoldAuthentication = true,
    enforceHoldBinding = true,
    enforceCertificateAuthentication = true,
    enforceDecisionBinding = true,
    enforceDismissalAuthentication = true,
    enforceDismissalBinding = true,
    mutateAssetOnCaseOpen = false,
    mutateAssetOnDismissal = true,
    enforceSourceAuthentication = true,
    enforceSourceBinding = true,
    enforceSourceCursor = true,
    resolveHoldOnCaseClose = false
  ).* from "./EvidenceLineageCase"
}

module evidenceLineageCaseBrokenSourceAuthentication {
  import evidenceLineageCase(
    enforceHoldAuthentication = true,
    enforceHoldBinding = true,
    enforceCertificateAuthentication = true,
    enforceDecisionBinding = true,
    enforceDismissalAuthentication = true,
    enforceDismissalBinding = true,
    mutateAssetOnCaseOpen = false,
    mutateAssetOnDismissal = false,
    enforceSourceAuthentication = false,
    enforceSourceBinding = true,
    enforceSourceCursor = true,
    resolveHoldOnCaseClose = false
  ).* from "./EvidenceLineageCase"
}

module evidenceLineageCaseBrokenSourceBinding {
  import evidenceLineageCase(
    enforceHoldAuthentication = true,
    enforceHoldBinding = true,
    enforceCertificateAuthentication = true,
    enforceDecisionBinding = true,
    enforceDismissalAuthentication = true,
    enforceDismissalBinding = true,
    mutateAssetOnCaseOpen = false,
    mutateAssetOnDismissal = false,
    enforceSourceAuthentication = true,
    enforceSourceBinding = false,
    enforceSourceCursor = true,
    resolveHoldOnCaseClose = false
  ).* from "./EvidenceLineageCase"
}

module evidenceLineageCaseBrokenSourceCursor {
  import evidenceLineageCase(
    enforceHoldAuthentication = true,
    enforceHoldBinding = true,
    enforceCertificateAuthentication = true,
    enforceDecisionBinding = true,
    enforceDismissalAuthentication = true,
    enforceDismissalBinding = true,
    mutateAssetOnCaseOpen = false,
    mutateAssetOnDismissal = false,
    enforceSourceAuthentication = true,
    enforceSourceBinding = true,
    enforceSourceCursor = false,
    resolveHoldOnCaseClose = false
  ).* from "./EvidenceLineageCase"
}

module evidenceLineageCaseBrokenAutomaticHoldResolution {
  import evidenceLineageCase(
    enforceHoldAuthentication = true,
    enforceHoldBinding = true,
    enforceCertificateAuthentication = true,
    enforceDecisionBinding = true,
    enforceDismissalAuthentication = true,
    enforceDismissalBinding = true,
    mutateAssetOnCaseOpen = false,
    mutateAssetOnDismissal = false,
    enforceSourceAuthentication = true,
    enforceSourceBinding = true,
    enforceSourceCursor = true,
    resolveHoldOnCaseClose = true
  ).* from "./EvidenceLineageCase"
}
