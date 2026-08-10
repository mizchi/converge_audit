///|
pub(all) enum HistoricalKeyAdmissionDecision {
  AdmitHistoricalKey
  RejectHistoricalKeyMetadata
  RejectHistoricalKeyBinding
  RejectHistoricalKeyStatementFromFuture
  RejectHistoricalKeyNotYetValidAtIssuance
  RejectHistoricalKeyExpiredAtIssuance
  RejectHistoricalKeyRevokedAtIssuance
  RejectHistoricalKeyScheme
  RejectHistoricalKeySignature
} derive(Eq, Debug)

///|
/// Pure admission rule for a signature whose exact historical key record has
/// already been selected by `(key_id, key_version)`. Key validity and
/// revocation are evaluated at signed issuance time. Verification time is used
/// only to reject a statement from the future.
pub fn classify_historical_key_admission(
  key_binding_matches~ : Bool,
  key_version~ : Int,
  key_valid_from_ms~ : Int,
  key_valid_until_ms~ : Int,
  key_revoked~ : Bool,
  key_revoked_at_ms~ : Int,
  statement_issued_at_ms~ : Int,
  verification_time_ms~ : Int,
  max_clock_skew_ms~ : Int,
  scheme_supported~ : Bool,
  signature_valid~ : Bool,
) -> HistoricalKeyAdmissionDecision where {
  proof_ensure: decision => {
    historical_key_admission_post(
      key_binding_matches, key_version, key_valid_from_ms, key_valid_until_ms, key_revoked,
      key_revoked_at_ms, statement_issued_at_ms, verification_time_ms, max_clock_skew_ms,
      scheme_supported, signature_valid, decision,
    )
  },
} {
  let metadata_valid = key_version > 0 &&
    key_valid_from_ms >= 0 &&
    key_valid_until_ms > key_valid_from_ms &&
    statement_issued_at_ms >= 0 &&
    verification_time_ms >= 0 &&
    max_clock_skew_ms >= 0
  let decision = if !metadata_valid {
    RejectHistoricalKeyMetadata
  } else if !key_binding_matches {
    RejectHistoricalKeyBinding
  } else if statement_issued_at_ms > verification_time_ms + max_clock_skew_ms {
    RejectHistoricalKeyStatementFromFuture
  } else if statement_issued_at_ms < key_valid_from_ms {
    RejectHistoricalKeyNotYetValidAtIssuance
  } else if statement_issued_at_ms >= key_valid_until_ms {
    RejectHistoricalKeyExpiredAtIssuance
  } else if key_revoked && statement_issued_at_ms >= key_revoked_at_ms {
    RejectHistoricalKeyRevokedAtIssuance
  } else if !scheme_supported {
    RejectHistoricalKeyScheme
  } else if !signature_valid {
    RejectHistoricalKeySignature
  } else {
    AdmitHistoricalKey
  }
  proof_assert historical_key_admission_post(
    key_binding_matches, key_version, key_valid_from_ms, key_valid_until_ms, key_revoked,
    key_revoked_at_ms, statement_issued_at_ms, verification_time_ms, max_clock_skew_ms,
    scheme_supported, signature_valid, decision,
  )
  decision
}
