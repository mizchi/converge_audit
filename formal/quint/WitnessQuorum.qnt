// Authoritative witness quorum protocol model.
module witnessQuorum {
  type Actor = W1 | W2 | W3 | W4 | Intruder
  type Status = Collecting | Ready | Expired
  type Classification = Unclassified | Pending | Invalid

  type Response = {
    witness: Actor,
    valid: bool,
  }

  /// State of one destination-specific witness collection.
  type State = {
    network: Set[Response],
    acceptedWitnesses: Set[Actor],
    status: Status,
    classification: Classification,
    receiverAdvanced: bool,
  }

  const requiredApprovals: int
  const producerSignatureValid: bool
  const enforceProducerSignature: bool
  const enforceRoster: bool
  const allowExpire: bool

  pure val Roster = Set(W1, W2, W3, W4)
  pure val Actors = Roster.union(Set(Intruder))

  /// Executable quorum-range contract checked by every healthy verification.
  pure val configIsValid = and {
    requiredApprovals >= 1,
    requiredApprovals <= Roster.size(),
  }

  assume ValidRequiredApprovals = configIsValid

  var state: State

  /// Start one unclassified witness collection with an empty message soup.
  action init = {
    state' = {
      network: Set(),
      acceptedWitnesses: Set(),
      status: Collecting,
      classification: Unclassified,
      receiverAdvanced: false,
    }
  }

  action sendHonestApproval(witness: Actor): bool = {
    val response = { witness: witness, valid: true }
    all {
      witness.in(Roster),
      state.status == Collecting,
      not(witness.in(state.acceptedWitnesses)),
      not(response.in(state.network)),
      state' = {
        ...state,
        network: state.network.union(Set(response)),
      },
    }
  }

  action sendHostileResponse(witness: Actor, valid: bool): bool = {
    val response = { witness: witness, valid: valid }
    all {
      witness.in(Actors),
      not(response.in(state.network)),
      state' = {
        ...state,
        network: state.network.union(Set(response)),
      },
    }
  }

  /// Consume one response and move to Ready only after producer authentication
  /// and a distinct roster quorum both succeed.
  action deliverResponse(response: Response): bool = {
    val rosterAccepted = response.valid and (
      response.witness.in(Roster) or not(enforceRoster)
    )
    val nextAccepted =
      if (state.status == Collecting and rosterAccepted)
        state.acceptedWitnesses.union(Set(response.witness))
      else state.acceptedWitnesses
    val producerAccepted =
      producerSignatureValid or not(enforceProducerSignature)
    val quorumReached = nextAccepted.size() >= requiredApprovals
    all {
      response.in(state.network),
      state' = {
        ...state,
        network: state.network.exclude(Set(response)),
        acceptedWitnesses: nextAccepted,
        status:
          if (state.status == Collecting and producerAccepted and quorumReached)
            Ready
          else state.status,
      },
    }
  }

  /// Expiry is a pending classification, never proof that the producer cheated.
  action expire = all {
    allowExpire,
    state.status == Collecting,
    state' = {
      ...state,
      status: Expired,
      classification: Pending,
    },
  }

  /// Gate the downstream receiver update on a Ready collection.
  action advanceReceiver = all {
    state.status == Ready,
    not(state.receiverAdvanced),
    state' = { ...state, receiverAdvanced: true },
  }

  /// Bind parameterized protocol actions to nondeterministic arguments for
  /// `step` and fairness.
  action sendSomeHonestApproval = {
    nondet witness = Roster.oneOf()
    sendHonestApproval(witness)
  }

  action sendSomeHostileResponse = {
    nondet witness = Actors.oneOf()
    nondet valid = Set(true, false).oneOf()
    sendHostileResponse(witness, valid)
  }

  action deliverSomeResponse = {
    nondet response = state.network.oneOf()
    deliverResponse(response)
  }

  /// Fairness relation for an unconsumed honest approval. It is a semantic
  /// subset of `deliverSomeResponse`, which is the branch in `step`.
  action deliverSomeHonestResponse = {
    nondet response = state.network.filter(response => and {
      response.valid,
      response.witness.in(Roster),
      not(response.witness.in(state.acceptedWitnesses)),
    }).oneOf()
    deliverResponse(response)
  }

  action step = any {
    sendSomeHonestApproval,
    sendSomeHostileResponse,
    deliverSomeResponse,
    expire,
    advanceReceiver,
  }

  val typeOk = and {
    state.acceptedWitnesses.subseteq(Actors),
    state.network.forall(response => response.witness.in(Actors)),
  }

  val readyRequiresAuthenticatedDistinctRosterQuorum =
    state.status == Ready implies and {
      producerSignatureValid,
      state.acceptedWitnesses.subseteq(Roster),
      state.acceptedWitnesses.size() >= requiredApprovals,
    }

  val receiverRequiresReadyCollection =
    state.receiverAdvanced implies state.status == Ready

  val timeoutNeverMarksInvalid = state.classification != Invalid

  val expiredCollectionNeverAdvances =
    state.status == Expired implies not(state.receiverAdvanced)

  /// Aggregate retained for interactive use and the bounded Apalache smoke.
  val safety = and {
    configIsValid,
    typeOk,
    readyRequiresAuthenticatedDistinctRosterQuorum,
    receiverRequiresReadyCollection,
    timeoutNeverMarksInvalid,
    expiredCollectionNeverAdvances,
  }

  val vars = state

  /// Strong fairness prevents an intermittently enabled honest approval from
  /// being starved; receiver advancement needs only weak fairness.
  temporal fairness = and {
    strongFair(sendSomeHonestApproval, vars),
    strongFair(deliverSomeResponse, vars),
    strongFair(deliverSomeHonestResponse, vars),
    weakFair(advanceReceiver, vars),
  }

  /// With expiry disabled, fair honest approval delivery eventually reaches
  /// Ready.
  temporal allHonestApprovalsEventuallyReady =
    fairness implies eventually(state.status == Ready)
}
