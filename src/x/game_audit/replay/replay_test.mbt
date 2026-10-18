///|
fn authenticated_effect_event(
  effect : @replay.AssetEffect,
  session_id? : String = "dungeon-42",
  counter? : Int = 0,
  signer_name? : String = "game-server",
) -> @bft.AuthenticatedEvent raise Error {
  let adapter = @bft.AuditAdapter::new(
    @bft.FnvHasher::new(),
    @bft.MockVerifier::new(),
    session_id~,
  )
  let signer = @bft.MockSigner::new(signer_name)
  assert_true(
    adapter.register_peer(@types.PeerId(signer_name), signer.public_key()),
  )
  let event = @replay.make_asset_effect_event(
    peer=@types.PeerId(signer_name),
    counter~,
    lamport=counter + 1,
    deps=[],
    effect~,
  )
  match adapter.deliver(adapter.sign(signer, event, [])) {
    Accepted(source) => source
    _ => fail("expected authenticated effect event")
  }
}

///|
fn create_effect(
  asset_id? : String = "asset-1",
  recipient_id? : String = "alice",
  quantity? : Int = 1,
) -> @replay.AssetEffect {
  @replay.AssetEffect::Create(
    asset_id~,
    recipient_id~,
    item_type="rare-sword",
    quantity~,
    output_index=0,
  )
}

///|
fn replay_engine(session_id? : String = "dungeon-42") -> @replay.ReplayEngine {
  let kernel = @replay.CanonicalAssetKernel::new(
    @bft.FnvHasher::new(),
    effect_author=@bft.PublicKey("game-server"),
  )
  @replay.ReplayEngine::new(kernel, session_id~)
}

///|
struct EmptyHasher {}

///|
impl @bft.Hasher for EmptyHasher with fn hash_string(
  self : EmptyHasher,
  value : String,
) -> @bft.Digest {
  ignore(self)
  ignore(value)
  @bft.Digest("")
}

///|
test "canonical kernel manifest binds the configured effect author" {
  let hasher = @bft.FnvHasher::new()
  let alice = @replay.CanonicalAssetKernel::new(
    hasher,
    effect_author=@bft.PublicKey("alice"),
  )
  let bob = @replay.CanonicalAssetKernel::new(
    hasher,
    effect_author=@bft.PublicKey("bob"),
  )
  assert_not_eq(alice.manifest_digest(), bob.manifest_digest())
}

///|
test "canonical creation event mints an exact replay capability" {
  let effect = create_effect()
  let source = authenticated_effect_event(effect)
  match replay_engine().replay(source, effect) {
    Replayed(capability) => {
      assert_eq(capability.source_digest(), source.digest())
      assert_not_eq(capability.manifest_digest(), @bft.Digest(""))
      assert_eq(capability.effect(), effect)
      assert_true(
        capability.matches(
          session_id="dungeon-42",
          manifest_digest=capability.manifest_digest(),
          source_digest=source.digest(),
          effect~,
        ),
      )
    }
    _ => fail("valid canonical creation was not replayed")
  }
}

///|
test "event payload cannot authorize a different effect" {
  let declared = create_effect()
  let requested = create_effect(asset_id="asset-2")
  let source = authenticated_effect_event(declared)
  assert_eq(
    replay_engine().replay(source, requested),
    @replay.ReplayResult::Refused(@replay.ReplayRefusal::KernelRejected),
  )
}

///|
test "authenticated non-author event cannot mint an asset effect" {
  let effect = create_effect()
  let source = authenticated_effect_event(effect, signer_name="mallory")
  assert_eq(
    replay_engine().replay(source, effect),
    @replay.ReplayResult::Refused(@replay.ReplayRefusal::KernelRejected),
  )
}

///|
test "replay rejects a source authenticated for another session" {
  let effect = create_effect()
  let source = authenticated_effect_event(effect, session_id="other-dungeon")
  assert_eq(
    replay_engine().replay(source, effect),
    @replay.ReplayResult::Refused(@replay.ReplayRefusal::SessionMismatch),
  )
  let empty_source = authenticated_effect_event(effect, session_id="")
  assert_eq(
    replay_engine(session_id="").replay(empty_source, effect),
    @replay.ReplayResult::Refused(@replay.ReplayRefusal::SessionMismatch),
  )
}

///|
test "invalid effect and empty kernel manifest fail closed" {
  let invalid = create_effect(quantity=0)
  let source = authenticated_effect_event(invalid)
  assert_eq(
    replay_engine().replay(source, invalid),
    @replay.ReplayResult::Refused(@replay.ReplayRefusal::InvalidEffect),
  )
  let valid = create_effect()
  let valid_source = authenticated_effect_event(valid)
  let empty_manifest_kernel = @replay.CanonicalAssetKernel::new(
    EmptyHasher::{ },
    effect_author=@bft.PublicKey("game-server"),
  )
  let empty_manifest_engine = @replay.ReplayEngine::new(
    empty_manifest_kernel,
    session_id="dungeon-42",
  )
  assert_eq(
    empty_manifest_engine.replay(valid_source, valid),
    @replay.ReplayResult::Refused(@replay.ReplayRefusal::InvalidManifest),
  )
}

///|
test "canonical transfer effect is deterministic and tamper evident" {
  let effect = @replay.AssetEffect::Transfer(
    asset_id="asset-1",
    from_owner="alice",
    to_owner="bob",
    expected_version=0,
  )
  let source = authenticated_effect_event(effect, counter=1)
  match replay_engine().replay(source, effect) {
    Replayed(capability) => {
      let manifest = capability.manifest_digest()
      assert_true(
        capability.matches(
          session_id="dungeon-42",
          manifest_digest=manifest,
          source_digest=source.digest(),
          effect~,
        ),
      )
      assert_false(
        capability.matches(
          session_id="dungeon-42",
          manifest_digest=manifest,
          source_digest=source.digest(),
          effect=@replay.AssetEffect::Transfer(
            asset_id="asset-1",
            from_owner="mallory",
            to_owner="bob",
            expected_version=0,
          ),
        ),
      )
    }
    _ => fail("valid canonical transfer was not replayed")
  }
}
