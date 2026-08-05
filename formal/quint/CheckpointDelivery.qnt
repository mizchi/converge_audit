// Authoritative checkpoint delivery protocol model.
//
// The model deliberately keeps the same finite boundary: two peers, two
// epochs, three events, a durable local checkpoint/outbox boundary, and one
// authority. Cryptographic validity and Merkle construction remain abstract.
module checkpointDelivery {
  type Peer = P1 | P2
  type Node = PeerNode(Peer) | Authority
  type Event = EventA | EventB | EventC

  type Digest = {
    epoch: int,
    events: Set[Event],
  }

  type Checkpoint = {
    producer: Peer,
    epoch: int,
    parent: Digest,
    events: Set[Event],
  }

  type EventMessage = {
    sender: Peer,
    receiver: Peer,
    event: Event,
  }

  /// Complete protocol state. A single record keeps each transition atomic and
  /// gives fairness one explicit state value to observe.
  type State = {
    accepted: Peer -> Set[Event],
    headLog: Node -> List[Checkpoint],
    durableCheckpoints: Peer -> Set[Checkpoint],
    volatileOutbox: Peer -> Set[Checkpoint],
    durableOutbox: Peer -> Set[Checkpoint],
    eventNetwork: Set[EventMessage],
    checkpointNetwork: Set[Checkpoint],
    sentEventMessages: Set[EventMessage],
    sentCheckpoints: Set[Checkpoint],
    up: Node -> bool,
    crashedOnce: Peer -> bool,
    partitioned: bool,
  }

  const requireCompleteBeforeSeal: bool
  const durableOutboxEnabled: bool
  const exactParentEnabled: bool
  const retryEnabled: bool
  const enforceOutboxCapacity: bool
  const outboxCapacity: int
  const allowCrash: bool
  const allowPartition: bool
  const allowDrop: bool

  /// Executable form of the model-configuration contract. Keep this as a
  /// checked invariant because Quint 0.32.0 does not pass `assume` to TLC.
  pure val configIsValid = outboxCapacity > 0

  assume PositiveOutboxCapacity = configIsValid

  pure val Peers = Set(P1, P2)
  pure val Nodes = Peers.map(peer => PeerNode(peer)).union(Set(Authority))
  pure val Events = Set(EventA, EventB, EventC)
  pure val Epochs = Set(1, 2)
  pure val MaxEpoch = 2
  pure val Genesis: Digest = { epoch: 0, events: Set() }

  pure def eventEpoch(event: Event): int =
    if (event == EventC) 2 else 1

  pure def eventOwner(event: Event): Peer =
    if (event == EventB) P2 else P1

  pure def expectedEvents(epoch: int): Set[Event] =
    Events.filter(event => eventEpoch(event) <= epoch)

  pure def digest(checkpoint: Checkpoint): Digest = {
    epoch: checkpoint.epoch,
    events: checkpoint.events,
  }

  var state: State

  def headEpoch(node: Node): int = {
    val log = state.headLog.get(node)
    if (log.length() == 0) 0 else log.nth(log.length() - 1).epoch
  }

  def currentDigest(node: Node): Digest = {
    val log = state.headLog.get(node)
    if (log.length() == 0) Genesis else digest(log.nth(log.length() - 1))
  }

  def authorityHas(checkpoint: Checkpoint): bool = {
    val log = state.headLog.get(Authority)
    log.indices().exists(index =>
      digest(log.nth(index)) == digest(checkpoint))
  }

  def availableOutbox(peer: Peer): Set[Checkpoint] =
    state.volatileOutbox.get(peer).union(state.durableOutbox.get(peer))

  /// Initialize durable replica state, volatile transport state, and authority
  /// state at genesis.
  action init = {
    state' = {
      accepted: Peers.mapBy(peer => Events.filter(event => eventOwner(event) == peer)),
      headLog: Nodes.mapBy(_ => List()),
      durableCheckpoints: Peers.mapBy(_ => Set()),
      volatileOutbox: Peers.mapBy(_ => Set()),
      durableOutbox: Peers.mapBy(_ => Set()),
      eventNetwork: Set(),
      checkpointNetwork: Set(),
      sentEventMessages: Set(),
      sentCheckpoints: Set(),
      up: Nodes.mapBy(_ => true),
      crashedOnce: Peers.mapBy(_ => false),
      partitioned: false,
    }
  }

  /// Enqueue one replica event for gossip without changing the receiver yet.
  action sendEvent(peer: Peer, receiver: Peer, event: Event): bool = {
    val message = { sender: peer, receiver: receiver, event: event }
    all {
      peer != receiver,
      state.up.get(PeerNode(peer)),
      event.in(state.accepted.get(peer)),
      not(event.in(state.accepted.get(receiver))),
      not(message.in(state.eventNetwork)),
      retryEnabled or not(message.in(state.sentEventMessages)),
      state' = {
        ...state,
        eventNetwork: state.eventNetwork.union(Set(message)),
        sentEventMessages: state.sentEventMessages.union(Set(message)),
      },
    }
  }

  action deliverEvent(message: EventMessage): bool = all {
    message.in(state.eventNetwork),
    not(state.partitioned),
    state.up.get(PeerNode(message.receiver)),
    state' = {
      ...state,
      accepted: state.accepted.setBy(
        message.receiver,
        events => events.union(Set(message.event))
      ),
      eventNetwork: state.eventNetwork.exclude(Set(message)),
    },
  }

  action dropEvent(message: EventMessage): bool = all {
    allowDrop,
    message.in(state.eventNetwork),
    state' = {
      ...state,
      eventNetwork: state.eventNetwork.exclude(Set(message)),
    },
  }

  /// Seal exactly the next epoch when its watermark is complete and the
  /// unacknowledged outbox still has capacity.
  action sealNextCheckpoint(peer: Peer): bool = {
    val epoch = headEpoch(PeerNode(peer)) + 1
    val checkpoint: Checkpoint = {
      producer: peer,
      epoch: epoch,
      parent: currentDigest(PeerNode(peer)),
      events: state.accepted.get(peer).intersect(expectedEvents(epoch)),
    }
    all {
      state.up.get(PeerNode(peer)),
      epoch.in(Epochs),
      not(requireCompleteBeforeSeal)
        or expectedEvents(epoch).subseteq(state.accepted.get(peer)),
      not(enforceOutboxCapacity) or availableOutbox(peer).size() < outboxCapacity,
      state' = {
        ...state,
        headLog: state.headLog.setBy(
          PeerNode(peer),
          log => log.append(checkpoint)
        ),
        durableCheckpoints: state.durableCheckpoints.setBy(
          peer,
          checkpoints => checkpoints.union(Set(checkpoint))
        ),
        volatileOutbox: state.volatileOutbox.setBy(
          peer,
          checkpoints => checkpoints.union(Set(checkpoint))
        ),
        durableOutbox:
          if (durableOutboxEnabled)
            state.durableOutbox.setBy(
              peer,
              checkpoints => checkpoints.union(Set(checkpoint))
            )
          else state.durableOutbox,
      },
    }
  }

  action sendCheckpoint(peer: Peer, checkpoint: Checkpoint): bool = all {
    state.up.get(PeerNode(peer)),
    checkpoint.in(availableOutbox(peer)),
    not(checkpoint.in(state.checkpointNetwork)),
    retryEnabled or not(checkpoint.in(state.sentCheckpoints)),
    state' = {
      ...state,
      checkpointNetwork: state.checkpointNetwork.union(Set(checkpoint)),
      sentCheckpoints: state.sentCheckpoints.union(Set(checkpoint)),
    },
  }

  /// Let the authority accept a duplicate or the exact next checkpoint and
  /// acknowledge it by clearing every producer outbox copy.
  action receiveCheckpoint(checkpoint: Checkpoint): bool = {
    val duplicate = authorityHas(checkpoint)
    val exactNext = and {
      checkpoint.epoch == headEpoch(Authority) + 1,
      checkpoint.parent == currentDigest(Authority),
    }
    val acceptedByPolicy = duplicate or (
      if (exactParentEnabled) exactNext
      else checkpoint.epoch > headEpoch(Authority)
    )
    all {
      checkpoint.in(state.checkpointNetwork),
      state.up.get(Authority),
      not(state.partitioned),
      acceptedByPolicy,
      state' = {
        ...state,
        headLog:
          if (duplicate) state.headLog
          else state.headLog.setBy(Authority, log => log.append(checkpoint)),
        checkpointNetwork: state.checkpointNetwork.exclude(Set(checkpoint)),
        volatileOutbox: state.volatileOutbox.setBy(
          checkpoint.producer,
          checkpoints => checkpoints.exclude(Set(checkpoint))
        ),
        durableOutbox: state.durableOutbox.setBy(
          checkpoint.producer,
          checkpoints => checkpoints.exclude(Set(checkpoint))
        ),
      },
    }
  }

  action dropCheckpoint(checkpoint: Checkpoint): bool = all {
    allowDrop,
    checkpoint.in(state.checkpointNetwork),
    state' = {
      ...state,
      checkpointNetwork: state.checkpointNetwork.exclude(Set(checkpoint)),
    },
  }

  /// Crash a peer once, losing volatile outbox state but preserving durable
  /// events, checkpoints, and durable outbox entries.
  action crash(peer: Peer): bool = all {
    allowCrash,
    state.up.get(PeerNode(peer)),
    not(state.crashedOnce.get(peer)),
    state' = {
      ...state,
      up: state.up.set(PeerNode(peer), false),
      crashedOnce: state.crashedOnce.set(peer, true),
      volatileOutbox: state.volatileOutbox.set(peer, Set()),
    },
  }

  action restart(peer: Peer): bool = all {
    not(state.up.get(PeerNode(peer))),
    state' = {
      ...state,
      up: state.up.set(PeerNode(peer), true),
    },
  }

  action partition = all {
    allowPartition,
    not(state.partitioned),
    state' = { ...state, partitioned: true },
  }

  action heal = all {
    state.partitioned,
    state' = { ...state, partitioned: false },
  }

  /// Bind parameterized protocol actions to nondeterministic arguments. These
  /// zero-argument wrappers are the relations used by `step` and fairness.
  action sendSomeEvent = {
    nondet peer = Peers.oneOf()
    nondet receiver = Peers.oneOf()
    nondet event = Events.oneOf()
    sendEvent(peer, receiver, event)
  }

  action deliverSomeEvent = {
    nondet message = state.eventNetwork.oneOf()
    deliverEvent(message)
  }

  action dropSomeEvent = {
    nondet message = state.eventNetwork.oneOf()
    dropEvent(message)
  }

  action sealSomeCheckpoint = {
    nondet peer = Peers.oneOf()
    sealNextCheckpoint(peer)
  }

  action sendSomeCheckpoint = {
    nondet peer = Peers.oneOf()
    nondet checkpoint = availableOutbox(peer).oneOf()
    sendCheckpoint(peer, checkpoint)
  }

  def isOldestAvailable(peer: Peer, checkpoint: Checkpoint): bool = and {
    checkpoint.in(availableOutbox(peer)),
    availableOutbox(peer).forall(other => checkpoint.epoch <= other.epoch),
  }

  /// Fairness relation for retrying the oldest available checkpoint. It is a
  /// semantic subset of `sendSomeCheckpoint`, which is the branch in `step`.
  action sendSomeOldestCheckpoint = {
    nondet peer = Peers.oneOf()
    nondet checkpoint = availableOutbox(peer).filter(
      candidate => isOldestAvailable(peer, candidate)
    ).oneOf()
    sendCheckpoint(peer, checkpoint)
  }

  action receiveSomeCheckpoint = {
    nondet checkpoint = state.checkpointNetwork.oneOf()
    receiveCheckpoint(checkpoint)
  }

  action dropSomeCheckpoint = {
    nondet checkpoint = state.checkpointNetwork.oneOf()
    dropCheckpoint(checkpoint)
  }

  action crashSomePeer = {
    nondet peer = Peers.oneOf()
    crash(peer)
  }

  action restartSomePeer = {
    nondet peer = Peers.oneOf()
    restart(peer)
  }

  /// All environment, transport, replica, and authority transitions.
  action step = any {
    sendSomeEvent,
    deliverSomeEvent,
    dropSomeEvent,
    sealSomeCheckpoint,
    sendSomeCheckpoint,
    receiveSomeCheckpoint,
    dropSomeCheckpoint,
    crashSomePeer,
    restartSomePeer,
    partition,
    heal,
  }

  // Quint's static types replace most of the structural TypeOK invariant. The
  // remaining clauses ensure every finite map keeps its complete key domain.
  val typeOk = and {
    state.accepted.keys() == Peers,
    state.headLog.keys() == Nodes,
    state.durableCheckpoints.keys() == Peers,
    state.volatileOutbox.keys() == Peers,
    state.durableOutbox.keys() == Peers,
    state.up.keys() == Nodes,
    state.crashedOnce.keys() == Peers,
  }

  val checkpointCompleteness =
    Peers.forall(peer =>
      state.durableCheckpoints.get(peer).forall(checkpoint =>
        checkpoint.events == expectedEvents(checkpoint.epoch)))

  val checkpointAgreement =
    Peers.forall(leftPeer =>
      Peers.forall(rightPeer =>
        state.durableCheckpoints.get(leftPeer).forall(left =>
          state.durableCheckpoints.get(rightPeer).forall(right =>
            left.epoch == right.epoch implies digest(left) == digest(right)))))

  def isExactChain(log: List[Checkpoint]): bool = and {
    log.indices().forall(index => log.nth(index).epoch == index + 1),
    log.length() == 0 or log.nth(0).parent == Genesis,
    log.indices().filter(index => index > 0).forall(index =>
      log.nth(index).parent == digest(log.nth(index - 1))),
  }

  val headLogsAreExactChains =
    Nodes.forall(node => isExactChain(state.headLog.get(node)))

  val acceptedEventsSurviveCrash =
    Events.forall(event => event.in(state.accepted.get(eventOwner(event))))

  val noLostSealedCheckpoint =
    Peers.forall(peer =>
      state.durableCheckpoints.get(peer).forall(checkpoint => or {
        authorityHas(checkpoint),
        checkpoint.in(state.volatileOutbox.get(peer)),
        checkpoint.in(state.durableOutbox.get(peer)),
        checkpoint.in(state.checkpointNetwork),
      }))

  val outboxWithinCapacity =
    Peers.forall(peer => availableOutbox(peer).size() <= outboxCapacity)

  val authorityAcceptsOnlyCreatedCheckpoints = {
    val log = state.headLog.get(Authority)
    log.indices().forall(index =>
      Peers.exists(peer =>
        log.nth(index).in(state.durableCheckpoints.get(peer))))
  }

  /// Aggregate retained for interactive use and the bounded Apalache smoke.
  /// CI passes the named invariants separately for precise failure reports.
  val safety = and {
    configIsValid,
    typeOk,
    checkpointCompleteness,
    checkpointAgreement,
    headLogsAreExactChains,
    acceptedEventsSurviveCrash,
    noLostSealedCheckpoint,
    outboxWithinCapacity,
    authorityAcceptsOnlyCreatedCheckpoints,
  }

  val authorityFinalized = headEpoch(Authority) == MaxEpoch
  val allNodesUp = Nodes.forall(node => state.up.get(node))
  val stableNetwork = not(state.partitioned) and allNodesUp
  val vars = state

  /// Delivery and retry use strong fairness because partitions and temporary
  /// disablement may recur. Seal, restart, and heal use weak fairness because
  /// they must progress only when continuously enabled.
  temporal fairness = and {
    strongFair(sendSomeEvent, vars),
    strongFair(deliverSomeEvent, vars),
    weakFair(sealSomeCheckpoint, vars),
    strongFair(sendSomeOldestCheckpoint, vars),
    strongFair(receiveSomeCheckpoint, vars),
    weakFair(restartSomePeer, vars),
    weakFair(heal, vars),
  }

  temporal authorityEventuallyFinalizes =
    fairness implies eventually(authorityFinalized)

  /// If the network eventually remains healthy, fair execution eventually
  /// finalizes the newest finite-model epoch at the authority.
  temporal stableNetworkLeadsToFinality =
    fairness implies (
      eventually(always(stableNetwork)) implies eventually(authorityFinalized)
    )
}
