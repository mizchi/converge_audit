#!/usr/bin/env sh
set -eu

quint typecheck formal/quint/CheckpointDelivery.qnt
quint typecheck formal/quint/WitnessQuorum.qnt

quint verify formal/quint/CheckpointDelivery.qnt \
  --backend=tlc \
  --main=checkpointSafety \
  --invariant=safety \
  --verbosity=1

quint verify formal/quint/CheckpointDelivery.qnt \
  --backend=tlc \
  --main=checkpointLiveness \
  --invariant=safety \
  --temporal=stableNetworkLeadsToFinality \
  --verbosity=1

quint verify formal/quint/WitnessQuorum.qnt \
  --backend=tlc \
  --main=witnessSafety \
  --invariant=safety \
  --verbosity=1

quint verify formal/quint/WitnessQuorum.qnt \
  --backend=tlc \
  --main=witnessLiveness \
  --invariant=typeOk,readyRequiresAuthenticatedDistinctRosterQuorum,receiverRequiresReadyCollection,timeoutNeverMarksInvalid \
  --temporal=allHonestApprovalsEventuallyReady \
  --verbosity=1
