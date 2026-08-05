// Authoritative witness quorum protocol model.
module witnessQuorum {
  type Actor = W1 | W2 | W3 | W4 | Intruder
  type Status = Collecting | Ready | Expired
  type Classification = Unclassified | Pending | Invalid

  type Response = {
    witness: Actor,
    valid: bool,
  }

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

  var state: State

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

  action expire = all {
    allowExpire,
    state.status == Collecting,
    state' = {
      ...state,
      status: Expired,
      classification: Pending,
    },
  }

  action advanceReceiver = all {
    state.status == Ready,
    not(state.receiverAdvanced),
    state' = { ...state, receiverAdvanced: true },
  }

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

  val safety = and {
    typeOk,
    readyRequiresAuthenticatedDistinctRosterQuorum,
    receiverRequiresReadyCollection,
    timeoutNeverMarksInvalid,
    expiredCollectionNeverAdvances,
  }

  val vars = state

  temporal fairness = and {
    strongFair(sendSomeHonestApproval, vars),
    strongFair(deliverSomeResponse, vars),
    strongFair(deliverSomeHonestResponse, vars),
    weakFair(advanceReceiver, vars),
  }

  temporal allHonestApprovalsEventuallyReady =
    fairness implies eventually(state.status == Ready)
}

module witnessSafety {
  import witnessQuorum(
    requiredApprovals = 3,
    producerSignatureValid = true,
    enforceProducerSignature = true,
    enforceRoster = true,
    allowExpire = true
  ).*
}

module witnessLiveness {
  import witnessQuorum(
    requiredApprovals = 3,
    producerSignatureValid = true,
    enforceProducerSignature = true,
    enforceRoster = true,
    allowExpire = false
  ).*
}

module witnessBrokenProducer {
  import witnessQuorum(
    requiredApprovals = 3,
    producerSignatureValid = false,
    enforceProducerSignature = false,
    enforceRoster = true,
    allowExpire = true
  ).*
}

module witnessBrokenRoster {
  import witnessQuorum(
    requiredApprovals = 3,
    producerSignatureValid = true,
    enforceProducerSignature = true,
    enforceRoster = false,
    allowExpire = true
  ).*
}
