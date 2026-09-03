///|
/// Adversarial in-memory network: delay, reorder, duplicate, partition, heal.
/// It never corrupts a delta; authenticity is the finalizer's job and payload
/// conflicts are the proposal lattice's job.
pub(all) struct Message[C] {
  sequence : Int
  sender : String
  receiver : String
  delta : @prdt.Delta[C]
}

///|
pub struct InMemoryNetwork[C] {
  queue : Array[Message[C]]
  mut sequence : Int
  mut groups : Map[String, Int]?
}

///|
pub fn[C] InMemoryNetwork::new() -> InMemoryNetwork[C] {
  { queue: [], sequence: 0, groups: None }
}

///|
pub fn[C] InMemoryNetwork::send(
  self : InMemoryNetwork[C],
  sender : String,
  receiver : String,
  delta : @prdt.Delta[C],
) -> Unit {
  self.queue.push({ sequence: self.sequence, sender, receiver, delta })
  self.sequence += 1
}

///|
pub fn[C] InMemoryNetwork::pending(self : InMemoryNetwork[C]) -> Int {
  self.queue.length()
}

///|
fn[C] InMemoryNetwork::deliverable_indices(
  self : InMemoryNetwork[C],
) -> Array[Int] {
  let out = []
  for index in 0..<self.queue.length() {
    let message = self.queue[index]
    let crossable = match self.groups {
      None => true
      Some(groups) => groups.get(message.sender) == groups.get(message.receiver)
    }
    if crossable {
      out.push(index)
    }
  }
  out
}

///|
/// Remove and return one deliverable message: FIFO, or a random one when `rng` is given.
pub fn[C] InMemoryNetwork::deliver_one(
  self : InMemoryNetwork[C],
  rng? : Rng,
) -> Message[C]? {
  let candidates = self.deliverable_indices()
  if candidates.length() == 0 {
    return None
  }
  let index = match rng {
    Some(rng) => rng.pick(candidates)
    None => candidates[0]
  }
  Some(self.queue.remove(index))
}

///|
/// Re-enqueue a copy of a random queued message (duplicate delivery).
pub fn[C] InMemoryNetwork::duplicate_one(
  self : InMemoryNetwork[C],
  rng : Rng,
) -> Bool {
  if self.queue.length() == 0 {
    return false
  }
  let original = rng.pick(self.queue)
  self.queue.push({ ..original, sequence: self.sequence })
  self.sequence += 1
  true
}

///|
pub fn[C] InMemoryNetwork::partition(
  self : InMemoryNetwork[C],
  groups : Array[Array[String]],
) -> Unit {
  let map : Map[String, Int] = Map([])
  for index, group in groups {
    for id in group {
      map[id] = index
    }
  }
  self.groups = Some(map)
}

///|
pub fn[C] InMemoryNetwork::heal(self : InMemoryNetwork[C]) -> Unit {
  self.groups = None
}

///|
pub fn[C] InMemoryNetwork::partitioned(self : InMemoryNetwork[C]) -> Bool {
  self.groups is Some(_)
}
