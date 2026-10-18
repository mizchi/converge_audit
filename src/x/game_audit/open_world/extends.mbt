///|
pub extend OpenWorldAuditEpochRefusal with Debug::{to_repr}

///|
pub extend OpenWorldAuditEpochRefusal with Eq::{not_equal, equal}

///|
pub extend OpenWorldAuditTransparencyEnvelope with Debug::{to_repr}

///|
pub extend OpenWorldAuditTransparencyEnvelope with Eq::{not_equal, equal}

///|
pub extend OpenWorldAuditTransparencyOpenResult with Debug::{to_repr}

///|
pub extend OpenWorldAuditTransparencyOpenResult with Eq::{not_equal, equal}

///|
pub extend OpenWorldAuditTransparencyRefusal with Debug::{to_repr}

///|
pub extend OpenWorldAuditTransparencyRefusal with Eq::{not_equal, equal}

///|
pub extend OpenWorldInMemoryObserverSigningAnchorGapTransport with OpenWorldObserverSigningAnchorGapTransport::{
  fetch,
}

///|
pub extend OpenWorldInMemoryObserverSigningStore with OpenWorldObserverSigningStore::{
  snapshot,
  proof,
  reserve,
}

///|
pub extend OpenWorldObservationAlert with Debug::{to_repr}

///|
pub extend OpenWorldObservationAlert with Eq::{not_equal, equal}

///|
pub extend OpenWorldObservationAlertKind with Debug::{to_repr}

///|
pub extend OpenWorldObservationAlertKind with Eq::{not_equal, equal}

///|
pub extend OpenWorldObservationDeliveryResult with Debug::{to_repr}

///|
pub extend OpenWorldObservationDeliveryResult with Eq::{not_equal, equal}

///|
pub extend OpenWorldObserverSigningAnchor with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningAnchor with Eq::{not_equal, equal}

///|
pub extend OpenWorldObserverSigningAnchorEnvelope with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningAnchorEnvelope with Eq::{not_equal, equal}

///|
pub extend OpenWorldObserverSigningAnchorEnvelopeOpenResult with Debug::{
  to_repr,
}

///|
pub extend OpenWorldObserverSigningAnchorEnvelopeOpenResult with Eq::{
  not_equal,
  equal,
}

///|
pub extend OpenWorldObserverSigningAnchorEnvelopeRefusal with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningAnchorEnvelopeRefusal with Eq::{
  not_equal,
  equal,
}

///|
pub extend OpenWorldObserverSigningAnchorFork with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningAnchorFork with Eq::{not_equal, equal}

///|
pub extend OpenWorldObserverSigningAnchorForkKind with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningAnchorForkKind with Eq::{not_equal, equal}

///|
pub extend OpenWorldObserverSigningAnchorGapFetchResult with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningAnchorGapFetchResult with Eq::{
  not_equal,
  equal,
}

///|
pub extend OpenWorldObserverSigningAnchorGapRecoveryResult with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningAnchorGapRecoveryResult with Eq::{
  not_equal,
  equal,
}

///|
pub extend OpenWorldObserverSigningAnchorGapRequest with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningAnchorGapRequest with Eq::{not_equal, equal}

///|
pub extend OpenWorldObserverSigningAnchorGapResponse with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningAnchorGapResponse with Eq::{not_equal, equal}

///|
pub extend OpenWorldObserverSigningAnchorHeadBatchDelivery with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningAnchorHeadBatchDelivery with Eq::{
  not_equal,
  equal,
}

///|
pub extend OpenWorldObserverSigningAnchorHeadDelivery with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningAnchorHeadDelivery with Eq::{
  not_equal,
  equal,
}

///|
pub extend OpenWorldObserverSigningAnchorPublicationRefusal with Debug::{
  to_repr,
}

///|
pub extend OpenWorldObserverSigningAnchorPublicationRefusal with Eq::{
  not_equal,
  equal,
}

///|
pub extend OpenWorldObserverSigningAnchorPublicationResult with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningAnchorPublicationResult with Eq::{
  not_equal,
  equal,
}

///|
pub extend OpenWorldObserverSigningRefusal with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningRefusal with Eq::{not_equal, equal}

///|
pub extend OpenWorldObserverSigningReservation with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningReservation with Eq::{not_equal, equal}

///|
pub extend OpenWorldObserverSigningResult with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningResult with Eq::{not_equal, equal}

///|
pub extend OpenWorldObserverSigningStoreSnapshot with Debug::{to_repr}

///|
pub extend OpenWorldObserverSigningStoreSnapshot with Eq::{not_equal, equal}

///|
pub extend OpenWorldRegistrationCertificate with Debug::{to_repr}

///|
pub extend OpenWorldRegistrationCertificate with Eq::{not_equal, equal}

///|
pub extend OpenWorldRegistrationCertificationResult with Debug::{to_repr}

///|
pub extend OpenWorldRegistrationCertificationResult with Eq::{not_equal, equal}

///|
pub extend OpenWorldRegistrationObservation with Debug::{to_repr}

///|
pub extend OpenWorldRegistrationObservation with Eq::{not_equal, equal}

///|
pub extend OpenWorldSealConflictKind with Debug::{to_repr}

///|
pub extend OpenWorldSealConflictKind with Eq::{not_equal, equal}

///|
pub extend OpenWorldSealConflictSource with Debug::{to_repr}

///|
pub extend OpenWorldSealConflictSource with Eq::{not_equal, equal}

///|
pub extend PublishedOpenWorldAuditTransparency with Debug::{to_repr}

///|
pub extend PublishedOpenWorldAuditTransparency with Eq::{not_equal, equal}

///|
pub extend PublishedOpenWorldObserverSigningAnchor with Debug::{to_repr}

///|
pub extend PublishedOpenWorldObserverSigningAnchor with Eq::{not_equal, equal}

///|
pub extend SignedOpenWorldRegistrationObservation with Debug::{to_repr}

///|
pub extend SignedOpenWorldRegistrationObservation with Eq::{not_equal, equal}
