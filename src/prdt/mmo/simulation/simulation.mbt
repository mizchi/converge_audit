///|
/// MMO wiring for the generic simulator: three players, random damage and
/// skills, a single shared-secret authority.
pub let players : Array[String] = ["player-a", "player-b", "player-c"]

///|
pub fn simulation_world() -> @mmo.World {
  @mmo.World::new(players.map(fn(id) { (id, { hp: 25, max_hp: 25, mp: 80 }) }))
}

///|
pub fn random_command(rng : @runtime.Rng, _tick : Int) -> @mmo.GameCommand {
  if rng.chance(0.5) {
    @mmo.Damage(
      source=rng.pick(players),
      target=rng.pick(players),
      amount=1 + rng.int(15),
    )
  } else {
    @mmo.UseSkill(
      actor=rng.pick(players),
      skill=rng.pick(["fireball", "heal"]),
      mp_cost=rng.int(30),
    )
  }
}

///|
pub fn run_mmo_simulation(
  seed~ : Int,
  steps? : Int = 400,
  replica_count? : Int = 3,
) -> @runtime.SimulationReport raise @prdt.ProtocolError {
  let hasher = @prdt.Sha256Hasher::new()
  let authenticator = @prdt.SharedSecretAuthenticator::new("authority", "sim")
  let finalizer = @prdt.SingleAuthorityFinalizer::new(
    hasher,
    authenticator,
    authenticator.public_key(),
  )
  let protocol = @mmo.game_protocol(
    finalizer,
    hasher,
    initial_world=simulation_world(),
  )
  let authority = @prdt.ClosureAuthority::new(
    hasher,
    authenticator,
    @mmo.game_order(),
  )
  @runtime.run_simulation(
    protocol,
    authority,
    random_command,
    seed~,
    steps~,
    replica_count~,
  )
}
