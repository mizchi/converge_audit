///|
/// Randomized distributed simulation.
///
/// N replicas (replica 0 is the single authority) exchange deltas over an
/// adversarial in-memory network with delays, reordering, duplication,
/// partitions, and crash/restart from checkpoint. At the end the partition is
/// healed, every message is delivered, and anti-entropy runs until
/// quiescence; the report then states whether every replica converged.
pub(all) struct SimulationCounters {
  mut proposals : Int
  mut deliveries : Int
  mut duplicates : Int
  mut partitions : Int
  mut heals : Int
  mut closures : Int
  mut restarts : Int
  mut checkpoints : Int
  mut anti_entropy : Int
  mut late_commands : Int
} derive(Eq, Debug)

///|
pub(all) struct SimulationReport {
  seed : Int
  counters : SimulationCounters
  replica_ids : Array[String]
  state_hashes : Array[String]
  committed_ticks : Array[Array[Int]]
  head_decision_hashes : Array[String]
  converged : Bool
  protocol_errors : Array[String]
} derive(Eq, Debug)

///|
pub impl ToJson for SimulationReport with fn to_json(self) {
  {
    "seed": self.seed.to_json(),
    "counters": {
      "proposals": self.counters.proposals.to_json(),
      "deliveries": self.counters.deliveries.to_json(),
      "duplicates": self.counters.duplicates.to_json(),
      "partitions": self.counters.partitions.to_json(),
      "heals": self.counters.heals.to_json(),
      "closures": self.counters.closures.to_json(),
      "restarts": self.counters.restarts.to_json(),
      "checkpoints": self.counters.checkpoints.to_json(),
      "anti_entropy": self.counters.anti_entropy.to_json(),
      "late_commands": self.counters.late_commands.to_json(),
    },
    "replica_ids": self.replica_ids.to_json(),
    "state_hashes": self.state_hashes.to_json(),
    "committed_ticks": self.committed_ticks.to_json(),
    "head_decision_hashes": self.head_decision_hashes.to_json(),
    "converged": self.converged.to_json(),
    "protocol_errors": self.protocol_errors.to_json(),
  }
}

///|
priv enum Action {
  Propose
  Deliver
  Duplicate
  Partition
  Heal
  Close
  Restart
  Checkpoint
  AntiEntropy
}

///|
let action_weights : Array[(Action, Int)] = [
  (Propose, 30),
  (Deliver, 40),
  (Duplicate, 6),
  (Partition, 3),
  (Heal, 4),
  (Close, 8),
  (Restart, 2),
  (Checkpoint, 4),
  (AntiEntropy, 5),
]

///|
fn pick_action(rng : Rng) -> Action {
  let mut total = 0
  for entry in action_weights {
    total += entry.1
  }
  let mut roll = rng.int(total)
  for entry in action_weights {
    if roll < entry.1 {
      return entry.0
    }
    roll -= entry.1
  }
  Deliver
}

///|
pub fn[
  S : ToJson + @json.FromJson,
  C : Eq + ToJson + @json.FromJson,
  E : ToJson + @json.FromJson,
  R : ToJson + @json.FromJson,
] run_simulation(
  protocol : @prdt.Protocol[S, C, E, R],
  authority : @prdt.ClosureAuthority[C],
  generate_command : (Rng, Int) -> C,
  seed~ : Int,
  steps~ : Int,
  replica_count? : Int = 3,
  tick_horizon? : Int = 2,
) -> SimulationReport raise @prdt.ProtocolError {
  let rng = Rng::new(seed)
  let network : InMemoryNetwork[C] = InMemoryNetwork::new()
  let ids : Array[String] = []
  for index in 0..<replica_count {
    ids.push("r" + index.to_string())
  }
  let replicas : Array[Replica[S, C, E, R]] = []
  for index, id in ids {
    let store = InMemoryCheckpointStore::new()
    if index == 0 {
      replicas.push(Replica::new(protocol, id, store, authority~))
    } else {
      replicas.push(Replica::new(protocol, id, store))
    }
  }
  let authority_replica = replicas[0]
  let by_id : Map[String, Replica[S, C, E, R]] = Map([])
  for replica in replicas {
    by_id[replica.id()] = replica
  }
  let counters : SimulationCounters = {
    proposals: 0,
    deliveries: 0,
    duplicates: 0,
    partitions: 0,
    heals: 0,
    closures: 0,
    restarts: 0,
    checkpoints: 0,
    anti_entropy: 0,
    late_commands: 0,
  }
  let protocol_errors : Array[String] = []
  let broadcast = fn(sender : Replica[S, C, E, R]) {
    for delta in sender.drain_outbox() {
      for receiver in ids {
        if receiver != sender.id() {
          network.send(sender.id(), receiver, delta)
        }
      }
    }
  }
  let deliver = fn() {
    match network.deliver_one(rng~) {
      None => ()
      Some(message) => {
        counters.deliveries += 1
        by_id.get(message.receiver).unwrap().receive(message.delta) catch {
          error =>
            protocol_errors.push(
              message.receiver + " <- " + message.sender + ": " + error.kind(),
            )
        }
      }
    }
  }
  for _step in 0..<steps {
    match pick_action(rng) {
      Propose => {
        let replica = rng.pick(replicas)
        let tick = authority_replica.next_tick() + rng.int(tick_horizon + 1)
        let _ = replica.propose(tick, generate_command(rng, tick))
        counters.proposals += 1
        broadcast(replica)
      }
      Deliver => deliver()
      Duplicate => if network.duplicate_one(rng) { counters.duplicates += 1 }
      Partition =>
        if !network.partitioned() && replica_count >= 2 {
          let shuffled = rng.shuffle(ids)
          let cut = 1 + rng.int(replica_count - 1)
          network.partition([
            shuffled[0:cut].to_owned(),
            shuffled[cut:].to_owned(),
          ])
          counters.partitions += 1
        }
      Heal =>
        if network.partitioned() {
          network.heal()
          counters.heals += 1
        }
      Close => {
        let _ = authority_replica.close_next_tick()
        counters.closures += 1
        broadcast(authority_replica)
      }
      Restart => {
        rng.pick(replicas).restart()
        counters.restarts += 1
      }
      Checkpoint => {
        let _ = rng.pick(replicas).checkpoint()
        counters.checkpoints += 1
      }
      AntiEntropy => {
        let sender = rng.pick(replicas)
        let receiver = rng.pick(ids.filter(fn(id) { id != sender.id() }))
        network.send(sender.id(), receiver, sender.full_delta())
        counters.anti_entropy += 1
      }
    }
  }

  // Quiescence: heal, drain, then full anti-entropy rounds.
  network.heal()
  while network.pending() > 0 {
    deliver()
  }
  for _round in 0..<(replica_count + 1) {
    for sender in replicas {
      broadcast(sender)
      for receiver in ids {
        if receiver != sender.id() {
          network.send(sender.id(), receiver, sender.full_delta())
        }
      }
    }
    while network.pending() > 0 {
      deliver()
    }
  }
  let mut late_total = 0
  for replica in replicas {
    for _, decision in replica.decision().commands {
      if decision is @prdt.DecisionLate(_) {
        late_total += 1
      }
    }
  }
  counters.late_commands = late_total / replica_count
  let state_hashes = replicas.map(fn(r) { r.state_hash() })
  let committed_ticks = replicas.map(fn(r) { r.decision().committed_ticks() })
  let head_decision_hashes = replicas.map(fn(r) {
    r.decision().head_decision_hash()
  })
  let all_equal = fn(values : Array[String]) {
    values.iter().all(fn(v) { v == values[0] })
  }
  let converged = protocol_errors.length() == 0 &&
    all_equal(state_hashes) &&
    all_equal(head_decision_hashes)
  {
    seed,
    counters,
    replica_ids: ids,
    state_hashes,
    committed_ticks,
    head_decision_hashes,
    converged,
    protocol_errors,
  }
}
