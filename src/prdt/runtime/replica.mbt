///|
/// Runtime replica: a replicated domain object plus an outbox and a durable
/// checkpoint store. A replica holding a `ClosureAuthority` can close ticks.
pub struct Replica[S, C, E, R] {
  id : String
  protocol : @prdt.Protocol[S, C, E, R]
  store : &CheckpointStore
  authority : @prdt.ClosureAuthority[C]?
  mut object : @prdt.ReplicatedDomain[S, C, E, R]
  mut outbox : Array[@prdt.Delta[C]]
}

///|
fn[
  S : ToJson + @json.FromJson,
  C : Eq + @json.FromJson,
  E : ToJson + @json.FromJson,
  R : ToJson + @json.FromJson,
] load_object(
  protocol : @prdt.Protocol[S, C, E, R],
  id : String,
  store : &CheckpointStore,
) -> @prdt.ReplicatedDomain[S, C, E, R] raise @prdt.ProtocolError {
  match store.load() {
    Some(snapshot) => @prdt.ReplicatedDomain::restore(protocol, snapshot)
    None => @prdt.ReplicatedDomain::new(protocol, id)
  }
}

///|
pub fn[
  S : ToJson + @json.FromJson,
  C : Eq + @json.FromJson,
  E : ToJson + @json.FromJson,
  R : ToJson + @json.FromJson,
] Replica::new(
  protocol : @prdt.Protocol[S, C, E, R],
  id : String,
  store : &CheckpointStore,
  authority? : @prdt.ClosureAuthority[C],
) -> Replica[S, C, E, R] raise @prdt.ProtocolError {
  {
    id,
    protocol,
    store,
    authority,
    object: load_object(protocol, id, store),
    outbox: [],
  }
}

///|
pub fn[S, C, E, R] Replica::id(self : Replica[S, C, E, R]) -> String {
  self.id
}

///|
pub fn[S, C, E, R] Replica::object(
  self : Replica[S, C, E, R],
) -> @prdt.ReplicatedDomain[S, C, E, R] {
  self.object
}

///|
pub fn[S, C, E, R] Replica::is_authority(self : Replica[S, C, E, R]) -> Bool {
  self.authority is Some(_)
}

///|
pub fn[S : ToJson, C : Eq + ToJson, E : ToJson, R : ToJson] Replica::propose(
  self : Replica[S, C, E, R],
  tick : Int,
  command : C,
) -> @prdt.Envelope[C] raise @prdt.ProtocolError {
  let proposal = self.object.propose(tick, command)
  let _ = self.checkpoint() // write-ahead: own proposals are durable before they leave
  self.outbox.push(proposal.delta)
  proposal.envelope
}

///|
pub fn[S : ToJson, C : Eq, E : ToJson, R : ToJson] Replica::receive(
  self : Replica[S, C, E, R],
  delta : @prdt.Delta[C],
) -> Unit raise @prdt.ProtocolError {
  self.object.merge(delta)
}

///|
/// Full knowledge for anti-entropy.
pub fn[S, C, E, R] Replica::full_delta(
  self : Replica[S, C, E, R],
) -> @prdt.Delta[C] {
  self.object.delta()
}

///|
pub fn[S, C, E, R] Replica::drain_outbox(
  self : Replica[S, C, E, R],
) -> Array[@prdt.Delta[C]] {
  let out = self.outbox
  self.outbox = []
  out
}

///|
pub fn[S, C, E, R] Replica::decision(
  self : Replica[S, C, E, R],
) -> @prdt.Decision[E, R] {
  self.object.decision()
}

///|
pub fn[S, C, E, R] Replica::domain_state(self : Replica[S, C, E, R]) -> S {
  self.object.domain_state()
}

///|
pub fn[S, C, E, R] Replica::next_tick(self : Replica[S, C, E, R]) -> Int {
  self.object.next_tick()
}

///|
pub fn[S, C : ToJson, E, R] Replica::state_hash(
  self : Replica[S, C, E, R],
) -> String {
  self.object.state_hash()
}

///|
pub fn[S : ToJson, C : ToJson, E : ToJson, R : ToJson] Replica::checkpoint(
  self : Replica[S, C, E, R],
) -> Json {
  let snapshot = self.object.snapshot()
  self.store.save(snapshot)
  snapshot
}

///|
/// Simulate a crash: drop in-memory state and the outbox, reload the last checkpoint.
pub fn[
  S : ToJson + @json.FromJson,
  C : Eq + @json.FromJson,
  E : ToJson + @json.FromJson,
  R : ToJson + @json.FromJson,
] Replica::restart(
  self : Replica[S, C, E, R],
) -> Unit raise @prdt.ProtocolError {
  self.object = load_object(self.protocol, self.id, self.store)
  self.outbox = []
}

///|
/// Close the next tick with every proposal currently known for it.
/// Returns `None` when this replica holds no closure authority.
pub fn[S : ToJson, C : Eq + ToJson, E : ToJson, R : ToJson] Replica::close_next_tick(
  self : Replica[S, C, E, R],
) -> @prdt.ClosureCertificate? raise @prdt.ProtocolError {
  let authority = match self.authority {
    Some(authority) => authority
    None => return None
  }
  let tick = self.next_tick()
  let known = self.object.state().proposals().for_tick(tick).values().to_array()
  let certificate = authority.close(
    tick,
    self.decision().head_decision_hash(),
    known,
  ) catch {
    @prdt.BatchTickMismatch(_, _, id) => raise @prdt.InvalidTick(id)
    @prdt.DuplicateCommandId(id) => raise @prdt.ConflictingProposal(id)
  }
  self.object.close_tick(certificate)
  let _ = self.checkpoint() // certificates are durable before they leave
  self.outbox.push({ proposals: [], closures: [certificate] })
  Some(certificate)
}
