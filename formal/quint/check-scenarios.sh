#!/usr/bin/env sh
set -eu

quint typecheck formal/quint/CheckpointDeliveryTests.qnt
quint typecheck formal/quint/WitnessQuorumTests.qnt

quint test formal/quint/CheckpointDeliveryTests.qnt \
  --main=checkpointDeliveryTests \
  --match='^(authorityFinalizesTwoEpochs|durableOutboxSurvivesCrash|fullOutboxBlocksNextSeal)$' \
  --verbosity=1

quint test formal/quint/WitnessQuorumTests.qnt \
  --main=witnessQuorumTests \
  --match='^(threeDistinctApprovalsAdvanceReceiver|intruderDoesNotCountTowardQuorum|expiryDoesNotAdvanceReceiver)$' \
  --verbosity=1
