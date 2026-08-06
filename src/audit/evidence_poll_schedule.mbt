///|
/// Pure claim guard shared by durable scheduler adapters. `lease_available`
/// means either no attempt is running or its persisted lease has expired.
pub fn player_local_evidence_poll_claim_allowed(
  now_ms : Int,
  deadline_at_ms : Int,
  next_poll_at_ms : Int,
  lease_available : Bool,
) -> Bool {
  now_ms >= 0 &&
  deadline_at_ms > now_ms &&
  next_poll_at_ms <= now_ms &&
  lease_available
}

///|
/// Deadline-capped lease expiry. `-1` denotes an invalid request.
pub fn player_local_evidence_poll_lease_expiry(
  now_ms : Int,
  deadline_at_ms : Int,
  lease_duration_ms : Int,
) -> Int {
  if now_ms < 0 || deadline_at_ms <= now_ms || lease_duration_ms <= 0 {
    return -1
  }
  let requested = now_ms + lease_duration_ms
  if requested <= now_ms {
    -1
  } else if requested > deadline_at_ms {
    deadline_at_ms
  } else {
    requested
  }
}

///|
/// Exponential retry delay capped before multiplication can overflow. `-1`
/// denotes invalid configuration.
pub fn player_local_evidence_poll_backoff_delay(
  failures : Int,
  base_backoff_ms : Int,
  max_backoff_ms : Int,
) -> Int {
  if failures < 0 || base_backoff_ms <= 0 || max_backoff_ms < base_backoff_ms {
    return -1
  }
  let mut delay = base_backoff_ms
  let mut remaining = failures
  while remaining > 0 && delay < max_backoff_ms {
    delay = if delay > max_backoff_ms / 2 { max_backoff_ms } else { delay * 2 }
    remaining -= 1
  }
  if delay > max_backoff_ms {
    max_backoff_ms
  } else {
    delay
  }
}

///|
/// Deadline-capped retry instant. `-1` denotes invalid input or overflow.
pub fn player_local_evidence_poll_next_retry_at(
  now_ms : Int,
  deadline_at_ms : Int,
  failures : Int,
  base_backoff_ms : Int,
  max_backoff_ms : Int,
) -> Int {
  if now_ms < 0 || deadline_at_ms <= now_ms {
    return -1
  }
  let delay = player_local_evidence_poll_backoff_delay(
    failures, base_backoff_ms, max_backoff_ms,
  )
  if delay < 0 {
    return -1
  }
  let requested = now_ms + delay
  if requested <= now_ms {
    -1
  } else if requested > deadline_at_ms {
    deadline_at_ms
  } else {
    requested
  }
}
