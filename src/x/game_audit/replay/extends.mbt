///|
pub extend AssetEffect with Debug::{to_repr}

///|
pub extend AssetEffect with Eq::{not_equal, equal}

///|
pub extend AssetEffectValidation with Debug::{to_repr}

///|
pub extend AssetEffectValidation with Eq::{not_equal, equal}

///|
pub extend CanonicalAssetKernel with AssetReplayKernel::{
  manifest_digest,
  replay,
}

///|
pub extend CheckpointReplayMatch with Debug::{to_repr}

///|
pub extend CheckpointReplayMatch with Eq::{not_equal, equal}

///|
pub extend DodgeEvidence with Debug::{to_repr}

///|
pub extend DodgeEvidence with Eq::{not_equal, equal}

///|
pub extend DodgeIntent with Debug::{to_repr}

///|
pub extend DodgeIntent with Eq::{not_equal, equal}

///|
pub extend DodgeReceipt with Debug::{to_repr}

///|
pub extend DodgeReceipt with Eq::{not_equal, equal}

///|
pub extend DungeonAttackTranscript with Debug::{to_repr}

///|
pub extend DungeonAttackTranscript with Eq::{not_equal, equal}

///|
pub extend DungeonEncounterAttack with Debug::{to_repr}

///|
pub extend DungeonEncounterAttack with Eq::{not_equal, equal}

///|
pub extend DungeonEncounterCandidate with Debug::{to_repr}

///|
pub extend DungeonEncounterCandidate with Eq::{not_equal, equal}

///|
pub extend DungeonEncounterCandidateResult with Debug::{to_repr}

///|
pub extend DungeonEncounterCandidateResult with Eq::{not_equal, equal}

///|
pub extend DungeonEncounterConfig with Debug::{to_repr}

///|
pub extend DungeonEncounterConfig with Eq::{not_equal, equal}

///|
pub extend DungeonEncounterFinalizeResult with Debug::{to_repr}

///|
pub extend DungeonEncounterFinalizeResult with Eq::{not_equal, equal}

///|
pub extend DungeonEncounterLootKernel with AssetReplayKernel::{
  manifest_digest,
  replay,
}

///|
pub extend DungeonEncounterPlayerState with Debug::{to_repr}

///|
pub extend DungeonEncounterPlayerState with Eq::{not_equal, equal}

///|
pub extend DungeonEncounterRefusal with Debug::{to_repr}

///|
pub extend DungeonEncounterRefusal with Eq::{not_equal, equal}

///|
pub extend DungeonEncounterResolution with Debug::{to_repr}

///|
pub extend DungeonEncounterResolution with Eq::{not_equal, equal}

///|
pub extend DungeonLootKernel with AssetReplayKernel::{manifest_digest, replay}

///|
pub extend DungeonPlayer with Debug::{to_repr}

///|
pub extend DungeonPlayer with Eq::{not_equal, equal}

///|
pub extend DungeonPlayerAttackEvidence with Debug::{to_repr}

///|
pub extend DungeonPlayerAttackEvidence with Eq::{not_equal, equal}

///|
pub extend DungeonPlayerAttackIntent with Debug::{to_repr}

///|
pub extend DungeonPlayerAttackIntent with Eq::{not_equal, equal}

///|
pub extend DungeonPlayerAttackReceipt with Debug::{to_repr}

///|
pub extend DungeonPlayerAttackReceipt with Eq::{not_equal, equal}

///|
pub extend DungeonRaidCandidate with Debug::{to_repr}

///|
pub extend DungeonRaidCandidate with Eq::{not_equal, equal}

///|
pub extend DungeonRaidCandidateResult with Debug::{to_repr}

///|
pub extend DungeonRaidCandidateResult with Eq::{not_equal, equal}

///|
pub extend DungeonRaidFinalizeResult with Debug::{to_repr}

///|
pub extend DungeonRaidFinalizeResult with Eq::{not_equal, equal}

///|
pub extend DungeonRaidRefusal with Debug::{to_repr}

///|
pub extend DungeonRaidRefusal with Eq::{not_equal, equal}

///|
pub extend DungeonRaidResolution with Debug::{to_repr}

///|
pub extend DungeonRaidResolution with Eq::{not_equal, equal}

///|
pub extend DungeonRaidRules with Debug::{to_repr}

///|
pub extend DungeonRaidRules with Eq::{not_equal, equal}

///|
pub extend DungeonReplayRefusal with Debug::{to_repr}

///|
pub extend DungeonReplayRefusal with Eq::{not_equal, equal}

///|
pub extend DungeonReplayResult with Debug::{to_repr}

///|
pub extend DungeonReplayResult with Eq::{not_equal, equal}

///|
pub extend DungeonResolution with Debug::{to_repr}

///|
pub extend DungeonResolution with Eq::{not_equal, equal}

///|
pub extend PvpCommandEvidence with Debug::{to_repr}

///|
pub extend PvpCommandEvidence with Eq::{not_equal, equal}

///|
pub extend PvpCommandIntent with Debug::{to_repr}

///|
pub extend PvpCommandIntent with Eq::{not_equal, equal}

///|
pub extend PvpCommandReceipt with Debug::{to_repr}

///|
pub extend PvpCommandReceipt with Eq::{not_equal, equal}

///|
pub extend PvpEpochCandidate with Debug::{to_repr}

///|
pub extend PvpEpochCandidate with Eq::{not_equal, equal}

///|
pub extend PvpEpochCandidateResult with Debug::{to_repr}

///|
pub extend PvpEpochCandidateResult with Eq::{not_equal, equal}

///|
pub extend PvpEpochConfig with Debug::{to_repr}

///|
pub extend PvpEpochConfig with Eq::{not_equal, equal}

///|
pub extend PvpEpochFinalizeResult with Debug::{to_repr}

///|
pub extend PvpEpochFinalizeResult with Eq::{not_equal, equal}

///|
pub extend PvpEpochRefusal with Debug::{to_repr}

///|
pub extend PvpEpochRefusal with Eq::{not_equal, equal}

///|
pub extend PvpEpochResolution with Debug::{to_repr}

///|
pub extend PvpEpochResolution with Eq::{not_equal, equal}

///|
pub extend PvpObjectiveRule with Debug::{to_repr}

///|
pub extend PvpObjectiveRule with Eq::{not_equal, equal}

///|
pub extend PvpPlayer with Debug::{to_repr}

///|
pub extend PvpPlayer with Eq::{not_equal, equal}

///|
pub extend PvpPlayerState with Debug::{to_repr}

///|
pub extend PvpPlayerState with Eq::{not_equal, equal}

///|
pub extend PvpTeam with Debug::{to_repr}

///|
pub extend PvpTeam with Eq::{not_equal, equal}

///|
pub extend PvpTeamState with Debug::{to_repr}

///|
pub extend PvpTeamState with Eq::{not_equal, equal}

///|
pub extend ReplayRefusal with Debug::{to_repr}

///|
pub extend ReplayRefusal with Eq::{not_equal, equal}

///|
pub extend ReplayResult with Debug::{to_repr}

///|
pub extend ReplayResult with Eq::{not_equal, equal}

///|
pub extend ReplayedAssetEffect with Debug::{to_repr}

///|
pub extend ReplayedAssetEffect with Eq::{not_equal, equal}

///|
pub extend TelegraphDungeonConfig with Debug::{to_repr}

///|
pub extend TelegraphDungeonConfig with Eq::{not_equal, equal}

///|
pub extend TelegraphedAttack with Debug::{to_repr}

///|
pub extend TelegraphedAttack with Eq::{not_equal, equal}
