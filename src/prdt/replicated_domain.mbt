///|
/// Replicated Domain Object
///
///   Pure Domain State Machine + Replicated Finalization Protocol
///
/// The replicated state is the triple (proposals, closures, committed). The
/// first two are what replicas exchange; the committed prefix is derived
/// deterministically from them and kept only as a materialization.
///
///   Knowledge state  ->  Speculative view  ->  Final decision
///   append/join          (client side)        never reverts
///
/// Every `Protocol` method is pure: it returns fresh values and never mutates
/// its inputs. `ReplicatedDomain` is a small mutable wrapper.
pub struct Protocol[S, C, E, R] {
  domain : Domain[S, C, E, R]
  order : CommandOrder[C]
  finalizer : &Finalizer
  hasher : &@bft.Hasher
  genesis_tick : Int
  genesis_hash : String
}

///|
pub struct State[S, C, E, R] {
  proposals : ProposalState[C]
  closures : ClosureMap
  committed : CommittedLog[ResolvedBatch[S, C, E, R]]
}

///|
/// What replicas exchange. The committed prefix is never transported.
pub(all) struct Delta[C] {
  proposals : Array[Envelope[C]]
  closures : Array[ClosureCertificate]
} derive(Eq, Debug)

///|
pub fn[C] Delta::empty() -> Delta[C] {
  { proposals: [], closures: [] }
}

///|
/// Decision order: `DecisionPending <= anything`; a final decision is only
/// `<=` itself. `DecisionLate` is a protocol-level rejection: the tick closed
/// without this command. It is final because closure is final.
pub(all) enum CommandDecision[E, R] {
  DecisionPending
  DecisionAccepted(Int, E)
  DecisionRejected(Int, R)
  DecisionLate(Int)
} derive(Eq, Debug)

///|
pub struct Decision[E, R] {
  commands : Map[String, CommandDecision[E, R]]
  committed_ticks : Array[Int]
  head_decision_hash : String
}

///|
pub fn[E, R] Decision::of(
  self : Decision[E, R],
  id : String,
) -> CommandDecision[E, R] {
  match self.commands.get(id) {
    Some(decision) => decision
    None => DecisionPending
  }
}

///|
pub fn[E, R] Decision::command_ids(self : Decision[E, R]) -> Array[String] {
  let ids = self.commands.keys().to_array()
  ids.sort()
  ids
}

///|
pub fn[E, R] Decision::committed_ticks(self : Decision[E, R]) -> Array[Int] {
  self.committed_ticks.copy()
}

///|
pub fn[E, R] Decision::head_decision_hash(self : Decision[E, R]) -> String {
  self.head_decision_hash
}

///|
pub fn[S : ToJson, C, E, R] Protocol::new(
  domain : Domain[S, C, E, R],
  order : CommandOrder[C],
  finalizer : &Finalizer,
  hasher : &@bft.Hasher,
  genesis_tick? : Int = 0,
) -> Protocol[S, C, E, R] {
  let initial_state_hash = hash_value(hasher, (domain.initial_state)())
  let genesis_hash = hash_json(hasher, {
    "genesis": "prdt/genesis/v1",
    "genesis_tick": genesis_tick.to_json(),
    "initial_state_hash": initial_state_hash.to_json(),
  })
  { domain, order, finalizer, hasher, genesis_tick, genesis_hash }
}

///|
pub fn[S, C, E, R] Protocol::genesis_hash(
  self : Protocol[S, C, E, R],
) -> String {
  self.genesis_hash
}

///|
pub fn[S, C, E, R] Protocol::genesis_tick(self : Protocol[S, C, E, R]) -> Int {
  self.genesis_tick
}

///|
pub fn[S, C, E, R] Protocol::hasher(
  self : Protocol[S, C, E, R],
) -> &@bft.Hasher {
  self.hasher
}

///|
pub fn[S, C, E, R] Protocol::order(
  self : Protocol[S, C, E, R],
) -> CommandOrder[C] {
  self.order
}

///|
pub fn[S, C, E, R] Protocol::domain(
  self : Protocol[S, C, E, R],
) -> Domain[S, C, E, R] {
  self.domain
}

///|
pub fn[S, C, E, R] Protocol::initial(
  self : Protocol[S, C, E, R],
) -> State[S, C, E, R] {
  ignore(self)
  {
    proposals: ProposalState::empty(),
    closures: ClosureMap::empty(),
    committed: CommittedLog::empty(),
  }
}

///|
pub fn[S, C, E, R] State::proposals(
  self : State[S, C, E, R],
) -> ProposalState[C] {
  self.proposals
}

///|
pub fn[S, C, E, R] State::closures(self : State[S, C, E, R]) -> ClosureMap {
  self.closures
}

///|
pub fn[S, C, E, R] State::committed(
  self : State[S, C, E, R],
) -> CommittedLog[ResolvedBatch[S, C, E, R]] {
  self.committed
}

///|
pub fn[S, C, E, R] Protocol::domain_state(
  self : Protocol[S, C, E, R],
  state : State[S, C, E, R],
) -> S {
  match state.committed.last() {
    Some(batch) => batch.result.resulting_state
    None => (self.domain.initial_state)()
  }
}

///|
pub fn[S, C, E, R] Protocol::next_tick(
  self : Protocol[S, C, E, R],
  state : State[S, C, E, R],
) -> Int {
  self.genesis_tick + state.committed.length()
}

///|
fn[S, C, E, R] Protocol::validate_certificate_shape(
  self : Protocol[S, C, E, R],
  certificate : ClosureCertificate,
) -> Unit raise ProtocolError {
  if !is_valid_tick(certificate.tick) || certificate.tick < self.genesis_tick {
    raise MalformedCertificate(certificate.tick, "tick before genesis")
  }
  let seen : Map[String, Unit] = Map([])
  for id in certificate.ordered_command_ids {
    if seen.contains(id) {
      raise MalformedCertificate(certificate.tick, "duplicate command id " + id)
    }
    seen[id] = ()
  }
  if !certificate_shape_ok(self.hasher, certificate) {
    raise MalformedCertificate(
      certificate.tick,
      "ordered_commands_hash does not match ids",
    )
  }
}

///|
/// Extend the committed prefix as far as closures and known commands allow.
fn[S : ToJson, C, E : ToJson, R : ToJson] Protocol::advance(
  self : Protocol[S, C, E, R],
  state : State[S, C, E, R],
) -> State[S, C, E, R] raise ProtocolError {
  let mut log = state.committed
  let mut domain_state = self.domain_state(state)
  while true {
    let tick = self.genesis_tick + log.length()
    let certificate = match state.closures.for_tick(tick) {
      Closed(certificate) => certificate
      ClosurePending => break
    }
    let parent = log.head_decision_hash(self.genesis_hash)
    if certificate.parent_decision_hash != parent {
      raise ChainMismatch(tick)
    }
    let known = state.proposals.for_tick(tick)
    let envelopes : Array[Envelope[C]] = []
    let mut complete = true
    for id in certificate.ordered_command_ids {
      match known.get(id) {
        Some(envelope) => envelopes.push(envelope)
        None => {
          complete = false
          break
        }
      }
    }
    if !complete {
      break
    }
    let batch = resolve_batch(
      tick,
      domain_state,
      envelopes,
      self.domain,
      self.order,
      self.hasher,
    ) catch {
      BatchTickMismatch(_, _, id) =>
        raise MalformedCertificate(
          tick,
          "command " + id + " is for another tick",
        )
      DuplicateCommandId(id) =>
        raise MalformedCertificate(tick, "duplicate command id " + id)
    }
    let resolved_ids = batch.results.map(fn(r) { r.envelope.id })
    if resolved_ids != certificate.ordered_command_ids {
      raise OrderMismatch(tick)
    }
    let verdicts = Json::array(
      batch.results.map(fn(r) {
        { "id": r.envelope.id.to_json(), "verdict": r.verdict.to_json() }
      }),
    )
    let result_hash = hash_json(self.hasher, {
      "tick": tick.to_json(),
      "parent_decision_hash": parent.to_json(),
      "ordered_commands_hash": certificate.ordered_commands_hash.to_json(),
      "resulting_state_hash": batch.resulting_state_hash.to_json(),
      "verdicts": verdicts,
    })
    domain_state = batch.resulting_state
    log = log.append({
      tick,
      parent_decision_hash: parent,
      ordered_commands_hash: certificate.ordered_commands_hash,
      result_hash,
      result: batch,
    })
  }
  { proposals: state.proposals, closures: state.closures, committed: log }
}

///|
/// Verify every certificate, join, and extend the committed prefix.
/// Raises `ProtocolError` and leaves `state` untouched on failure.
pub fn[S : ToJson, C : Eq, E : ToJson, R : ToJson] Protocol::apply_delta(
  self : Protocol[S, C, E, R],
  state : State[S, C, E, R],
  delta : Delta[C],
) -> State[S, C, E, R] raise ProtocolError {
  let mut proposals = state.proposals
  for envelope in delta.proposals {
    if !is_valid_tick(envelope.tick) {
      raise InvalidTick(envelope.id)
    }
    proposals = proposals.add(envelope)
  }
  for certificate in delta.closures {
    self.validate_certificate_shape(certificate)
    if !self.finalizer.verify_closure(certificate) {
      raise InvalidCertificate(certificate.tick)
    }
  }
  let closures = state.closures.merge(
    ClosureMap::from_certificates(delta.closures),
  )
  self.advance({ proposals, closures, committed: state.committed })
}

///|
/// Whole-state join. Verifies nothing; use `apply_delta` for untrusted input.
pub fn[S : ToJson, C : Eq, E : ToJson, R : ToJson] Protocol::join(
  self : Protocol[S, C, E, R],
  left : State[S, C, E, R],
  right : State[S, C, E, R],
) -> State[S, C, E, R] raise ProtocolError {
  self.advance({
    proposals: left.proposals.merge(right.proposals),
    closures: left.closures.merge(right.closures),
    committed: left.committed.merge(right.committed),
  })
}

///|
pub fn[S, C : Eq, E, R] Protocol::states_equal(
  self : Protocol[S, C, E, R],
  left : State[S, C, E, R],
  right : State[S, C, E, R],
) -> Bool {
  ignore(self)
  left.proposals.equals(right.proposals) &&
  left.closures.equals(right.closures) &&
  left.committed.equals(right.committed)
}

///|
/// Full knowledge as a delta, for anti-entropy.
pub fn[S, C, E, R] Protocol::delta_of(
  self : Protocol[S, C, E, R],
  state : State[S, C, E, R],
) -> Delta[C] {
  ignore(self)
  { proposals: state.proposals.list(), closures: state.closures.list() }
}

///|
pub fn[S, C, E, R] Protocol::decision(
  self : Protocol[S, C, E, R],
  state : State[S, C, E, R],
) -> Decision[E, R] {
  let commands : Map[String, CommandDecision[E, R]] = Map([])
  let verdict_by_tick : Map[Int, Map[String, Verdict[E, R]]] = Map([])
  for batch in state.committed.batches {
    let verdicts : Map[String, Verdict[E, R]] = Map([])
    for resolved in batch.result.results {
      verdicts[resolved.envelope.id] = resolved.verdict
    }
    verdict_by_tick[batch.tick] = verdicts
  }
  for tick in state.proposals.ticks() {
    let included : Map[String, Unit]? = match state.closures.for_tick(tick) {
      Closed(certificate) => {
        let set : Map[String, Unit] = Map([])
        for id in certificate.ordered_command_ids {
          set[id] = ()
        }
        Some(set)
      }
      ClosurePending => None
    }
    let known = state.proposals.for_tick(tick)
    let ids = known.keys().to_array()
    ids.sort()
    for id in ids {
      let verdict = match verdict_by_tick.get(tick) {
        Some(verdicts) => verdicts.get(id)
        None => None
      }
      commands[id] = match verdict {
        Some(Accepted(event)) => DecisionAccepted(tick, event)
        Some(Rejected(reason)) => DecisionRejected(tick, reason)
        None =>
          match included {
            Some(set) =>
              if set.contains(id) {
                DecisionPending
              } else {
                DecisionLate(tick)
              }
            None => DecisionPending
          }
      }
    }
  }
  {
    commands,
    committed_ticks: state.committed.batches.map(fn(b) { b.tick }),
    head_decision_hash: state.committed.head_decision_hash(self.genesis_hash),
  }
}

///|
/// Hash of the whole replicated state; equal hashes mean converged replicas.
pub fn[S, C : ToJson, E, R] Protocol::state_hash(
  self : Protocol[S, C, E, R],
  state : State[S, C, E, R],
) -> String {
  hash_json(self.hasher, {
    "proposals": state.proposals.list().to_json(),
    "closures": state.closures.list().to_json(),
    "committed": state.committed.result_hashes().to_json(),
  })
}

///|
pub impl[C : ToJson] ToJson for Delta[C] with fn to_json(self) {
  { "proposals": self.proposals.to_json(), "closures": self.closures.to_json() }
}

///|
pub impl[C : @json.FromJson] @json.FromJson for Delta[C] with fn from_json(
  json,
  path,
) {
  guard json is Object(fields) else {
    raise @json.JsonDecodeError((path, "Delta: expected object"))
  }
  {
    proposals: @json.from_json(
      json_field(fields, "proposals", path),
      path=path.add_key("proposals"),
    ),
    closures: @json.from_json(
      json_field(fields, "closures", path),
      path=path.add_key("closures"),
    ),
  }
}

///|
pub impl[S : ToJson, C : ToJson, E : ToJson, R : ToJson] ToJson for ResolvedBatch[
  S,
  C,
  E,
  R,
] with fn to_json(self) {
  {
    "tick": self.tick.to_json(),
    "previous_state_hash": self.previous_state_hash.to_json(),
    "ordered_command_hash": self.ordered_command_hash.to_json(),
    "results": self.results.to_json(),
    "resulting_state": self.resulting_state.to_json(),
    "resulting_state_hash": self.resulting_state_hash.to_json(),
  }
}

///|
pub impl[
  S : @json.FromJson,
  C : @json.FromJson,
  E : @json.FromJson,
  R : @json.FromJson,
] @json.FromJson for ResolvedBatch[S, C, E, R] with fn from_json(json, path) {
  guard json is Object(fields) else {
    raise @json.JsonDecodeError((path, "ResolvedBatch: expected object"))
  }
  {
    tick: @json.from_json(
      json_field(fields, "tick", path),
      path=path.add_key("tick"),
    ),
    previous_state_hash: @json.from_json(
      json_field(fields, "previous_state_hash", path),
      path=path.add_key("previous_state_hash"),
    ),
    ordered_command_hash: @json.from_json(
      json_field(fields, "ordered_command_hash", path),
      path=path.add_key("ordered_command_hash"),
    ),
    results: @json.from_json(
      json_field(fields, "results", path),
      path=path.add_key("results"),
    ),
    resulting_state: @json.from_json(
      json_field(fields, "resulting_state", path),
      path=path.add_key("resulting_state"),
    ),
    resulting_state_hash: @json.from_json(
      json_field(fields, "resulting_state_hash", path),
      path=path.add_key("resulting_state_hash"),
    ),
  }
}

///|
pub impl[R : ToJson] ToJson for CommittedBatch[R] with fn to_json(self) {
  {
    "tick": self.tick.to_json(),
    "parent_decision_hash": self.parent_decision_hash.to_json(),
    "ordered_commands_hash": self.ordered_commands_hash.to_json(),
    "result_hash": self.result_hash.to_json(),
    "result": self.result.to_json(),
  }
}

///|
pub impl[R : @json.FromJson] @json.FromJson for CommittedBatch[R] with fn from_json(
  json,
  path,
) {
  guard json is Object(fields) else {
    raise @json.JsonDecodeError((path, "CommittedBatch: expected object"))
  }
  {
    tick: @json.from_json(
      json_field(fields, "tick", path),
      path=path.add_key("tick"),
    ),
    parent_decision_hash: @json.from_json(
      json_field(fields, "parent_decision_hash", path),
      path=path.add_key("parent_decision_hash"),
    ),
    ordered_commands_hash: @json.from_json(
      json_field(fields, "ordered_commands_hash", path),
      path=path.add_key("ordered_commands_hash"),
    ),
    result_hash: @json.from_json(
      json_field(fields, "result_hash", path),
      path=path.add_key("result_hash"),
    ),
    result: @json.from_json(
      json_field(fields, "result", path),
      path=path.add_key("result"),
    ),
  }
}

///|
pub let snapshot_version : Int = 1

///|
pub fn[S : ToJson, C : ToJson, E : ToJson, R : ToJson] Protocol::snapshot(
  self : Protocol[S, C, E, R],
  state : State[S, C, E, R],
) -> Json {
  {
    "version": snapshot_version.to_json(),
    "genesis_tick": self.genesis_tick.to_json(),
    "proposals": state.proposals.list().to_json(),
    "closures": state.closures.list().to_json(),
    "committed": state.committed.batches.to_json(),
  }
}

///|
fn snapshot_field(
  fields : Map[String, Json],
  key : String,
) -> Json raise ProtocolError {
  match fields.get(key) {
    Some(value) => value
    None => raise SnapshotMismatch("missing field " + key)
  }
}

///|
fn[T : @json.FromJson] snapshot_decode(
  json : Json,
  what : String,
) -> T raise ProtocolError {
  @json.from_json(json) catch {
    @json.JsonDecodeError((_, message)) =>
      raise SnapshotMismatch(what + ": " + message)
  }
}

///|
/// Restore a snapshot. The persisted committed prefix is re-derived from the
/// persisted knowledge and must match it exactly; a snapshot is never trusted
/// blindly.
pub fn[
  S : ToJson + @json.FromJson,
  C : Eq + @json.FromJson,
  E : ToJson + @json.FromJson,
  R : ToJson + @json.FromJson,
] Protocol::restore(
  self : Protocol[S, C, E, R],
  json : Json,
) -> State[S, C, E, R] raise ProtocolError {
  guard json is Object(fields) else {
    raise SnapshotMismatch("snapshot: expected object")
  }
  let version : Int = snapshot_decode(
    snapshot_field(fields, "version"),
    "version",
  )
  if version != snapshot_version {
    raise SnapshotMismatch("unsupported snapshot version")
  }
  let genesis_tick : Int = snapshot_decode(
    snapshot_field(fields, "genesis_tick"),
    "genesis_tick",
  )
  if genesis_tick != self.genesis_tick {
    raise SnapshotMismatch("genesis tick mismatch")
  }
  let proposals : Array[Envelope[C]] = snapshot_decode(
    snapshot_field(fields, "proposals"),
    "proposals",
  )
  let closures : Array[ClosureCertificate] = snapshot_decode(
    snapshot_field(fields, "closures"),
    "closures",
  )
  let persisted : Array[CommittedBatch[ResolvedBatch[S, C, E, R]]] = snapshot_decode(
    snapshot_field(fields, "committed"),
    "committed",
  )
  let mut proposal_state : ProposalState[C] = ProposalState::empty()
  for envelope in proposals {
    proposal_state = proposal_state.add(envelope)
  }
  let closure_map = ClosureMap::from_certificates(closures)
  let recomputed = self.advance({
    proposals: proposal_state,
    closures: closure_map,
    committed: CommittedLog::empty(),
  })
  let persisted_log : CommittedLog[ResolvedBatch[S, C, E, R]] = {
    batches: persisted,
  }
  let compatible = recomputed.committed.equals(
    recomputed.committed.merge(persisted_log),
  ) catch {
    _ => false
  }
  if !compatible {
    raise SnapshotMismatch("committed prefix does not match recomputation")
  }
  recomputed
}

///|
/// Mutable convenience wrapper around the pure protocol.
pub struct ReplicatedDomain[S, C, E, R] {
  protocol : Protocol[S, C, E, R]
  replica_id : String
  mut state : State[S, C, E, R]
  mut next_local_sequence : Int
}

///|
pub(all) struct Proposal[C] {
  envelope : Envelope[C]
  delta : Delta[C]
} derive(Eq, Debug)

///|
pub fn[S, C, E, R] ReplicatedDomain::new(
  protocol : Protocol[S, C, E, R],
  replica_id : String,
) -> ReplicatedDomain[S, C, E, R] {
  { protocol, replica_id, state: protocol.initial(), next_local_sequence: 0 }
}

///|
pub fn[S, C, E, R] ReplicatedDomain::protocol(
  self : ReplicatedDomain[S, C, E, R],
) -> Protocol[S, C, E, R] {
  self.protocol
}

///|
pub fn[S, C, E, R] ReplicatedDomain::replica_id(
  self : ReplicatedDomain[S, C, E, R],
) -> String {
  self.replica_id
}

///|
pub fn[S, C, E, R] ReplicatedDomain::state(
  self : ReplicatedDomain[S, C, E, R],
) -> State[S, C, E, R] {
  self.state
}

///|
pub fn[S, C, E, R] ReplicatedDomain::next_local_sequence(
  self : ReplicatedDomain[S, C, E, R],
) -> Int {
  self.next_local_sequence
}

///|
/// Record a local proposal and return the delta to disseminate.
pub fn[S : ToJson, C : Eq, E : ToJson, R : ToJson] ReplicatedDomain::propose(
  self : ReplicatedDomain[S, C, E, R],
  tick : Int,
  command : C,
) -> Proposal[C] raise ProtocolError {
  let local_sequence = self.next_local_sequence
  let envelope : Envelope[C] = {
    id: command_id(self.replica_id, local_sequence),
    tick,
    submitted_by: self.replica_id,
    local_sequence,
    command,
  }
  let delta : Delta[C] = { proposals: [envelope], closures: [] }
  self.state = self.protocol.apply_delta(self.state, delta)
  self.next_local_sequence = local_sequence + 1
  { envelope, delta }
}

///|
pub fn[S : ToJson, C : Eq, E : ToJson, R : ToJson] ReplicatedDomain::merge(
  self : ReplicatedDomain[S, C, E, R],
  delta : Delta[C],
) -> Unit raise ProtocolError {
  self.state = self.protocol.apply_delta(self.state, delta)
}

///|
pub fn[S : ToJson, C : Eq, E : ToJson, R : ToJson] ReplicatedDomain::close_tick(
  self : ReplicatedDomain[S, C, E, R],
  certificate : ClosureCertificate,
) -> Unit raise ProtocolError {
  self.merge({ proposals: [], closures: [certificate] })
}

///|
pub fn[S, C, E, R] ReplicatedDomain::decision(
  self : ReplicatedDomain[S, C, E, R],
) -> Decision[E, R] {
  self.protocol.decision(self.state)
}

///|
pub fn[S, C, E, R] ReplicatedDomain::domain_state(
  self : ReplicatedDomain[S, C, E, R],
) -> S {
  self.protocol.domain_state(self.state)
}

///|
pub fn[S, C, E, R] ReplicatedDomain::next_tick(
  self : ReplicatedDomain[S, C, E, R],
) -> Int {
  self.protocol.next_tick(self.state)
}

///|
pub fn[S, C, E, R] ReplicatedDomain::delta(
  self : ReplicatedDomain[S, C, E, R],
) -> Delta[C] {
  self.protocol.delta_of(self.state)
}

///|
pub fn[S, C : ToJson, E, R] ReplicatedDomain::state_hash(
  self : ReplicatedDomain[S, C, E, R],
) -> String {
  self.protocol.state_hash(self.state)
}

///|
pub fn[S : ToJson, C : ToJson, E : ToJson, R : ToJson] ReplicatedDomain::snapshot(
  self : ReplicatedDomain[S, C, E, R],
) -> Json {
  {
    "state": self.protocol.snapshot(self.state),
    "replica_id": self.replica_id.to_json(),
    "next_local_sequence": self.next_local_sequence.to_json(),
  }
}

///|
pub fn[
  S : ToJson + @json.FromJson,
  C : Eq + @json.FromJson,
  E : ToJson + @json.FromJson,
  R : ToJson + @json.FromJson,
] ReplicatedDomain::restore(
  protocol : Protocol[S, C, E, R],
  json : Json,
) -> ReplicatedDomain[S, C, E, R] raise ProtocolError {
  guard json is Object(fields) else {
    raise SnapshotMismatch("replicated snapshot: expected object")
  }
  let replica_id : String = snapshot_decode(
    snapshot_field(fields, "replica_id"),
    "replica_id",
  )
  let next_local_sequence : Int = snapshot_decode(
    snapshot_field(fields, "next_local_sequence"),
    "next_local_sequence",
  )
  {
    protocol,
    replica_id,
    state: protocol.restore(snapshot_field(fields, "state")),
    next_local_sequence,
  }
}
