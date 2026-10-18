///|
test "peer certificates avoid central replay for ordinary durable outcomes" {
  assert_eq(
    @audit.route_open_world_audit(
      @audit.OpenWorldOutcomeClass::Durable,
      peer_certificate_matches=true,
      challenge_present=false,
      sample_selected=false,
      central_replay_present=false,
      central_replay_matches=false,
    ),
    @audit.OpenWorldAuditDecision::PeerAccepted,
  )
}

///|
test "sampling challenge and high value outcomes require central replay" {
  for
    route in [
      @audit.route_open_world_audit(
        @audit.OpenWorldOutcomeClass::Durable,
        peer_certificate_matches=true,
        challenge_present=false,
        sample_selected=true,
        central_replay_present=false,
        central_replay_matches=false,
      ),
      @audit.route_open_world_audit(
        @audit.OpenWorldOutcomeClass::Durable,
        peer_certificate_matches=true,
        challenge_present=true,
        sample_selected=false,
        central_replay_present=false,
        central_replay_matches=false,
      ),
      @audit.route_open_world_audit(
        @audit.OpenWorldOutcomeClass::HighValue,
        peer_certificate_matches=true,
        challenge_present=false,
        sample_selected=false,
        central_replay_present=false,
        central_replay_matches=false,
      ),
    ] {
    assert_eq(route, @audit.OpenWorldAuditDecision::CentralReplayRequired)
  }
}

///|
test "central replay acceptance and rejection are explicit" {
  assert_eq(
    @audit.route_open_world_audit(
      @audit.OpenWorldOutcomeClass::HighValue,
      peer_certificate_matches=false,
      challenge_present=true,
      sample_selected=true,
      central_replay_present=true,
      central_replay_matches=true,
    ),
    @audit.OpenWorldAuditDecision::CentralAccepted,
  )
  assert_eq(
    @audit.route_open_world_audit(
      @audit.OpenWorldOutcomeClass::Ephemeral,
      peer_certificate_matches=true,
      challenge_present=false,
      sample_selected=false,
      central_replay_present=true,
      central_replay_matches=false,
    ),
    @audit.OpenWorldAuditDecision::Rejected,
  )
}

///|
test "unwitnessed economic results escalate but visual-only results remain provisional" {
  assert_eq(
    @audit.route_open_world_audit(
      @audit.OpenWorldOutcomeClass::Durable,
      peer_certificate_matches=false,
      challenge_present=false,
      sample_selected=false,
      central_replay_present=false,
      central_replay_matches=false,
    ),
    @audit.OpenWorldAuditDecision::CentralReplayRequired,
  )
  assert_eq(
    @audit.route_open_world_audit(
      @audit.OpenWorldOutcomeClass::Ephemeral,
      peer_certificate_matches=false,
      challenge_present=false,
      sample_selected=false,
      central_replay_present=false,
      central_replay_matches=false,
    ),
    @audit.OpenWorldAuditDecision::Provisional,
  )
}
