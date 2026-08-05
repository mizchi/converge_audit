///|
async fn main {
  let args = @env.args()
  let spec = if args.length() >= 2 {
    args[1]
  } else {
    "formal/quint/AssetOwnershipModels.qnt"
  }
  let broken_revocation = args.any(arg => arg == "--broken-revocation")
  let seed = "0xa55e7"
  let config : @quint_connect.RunConfig = {
    spec,
    main: Some("assetOwnershipSafety"),
    init: Some("init"),
    step: Some("step"),
    max_samples: Some(32),
    max_steps: Some(8),
    backend: Some("typescript"),
    seed,
  }
  let trace_config : @quint_connect.TraceConfig = {
    state_path: ["assetOwnershipSafety::assetOwnership::state"],
    nondet_path: [],
  }
  let batch = match @runner.generate_run(config, trace_config~) {
    Ok(batch) => batch
    Err(reason) => abort("Quint trace generation failed: \{reason}")
  }
  let result = @quint_asset_driver.replay_asset_ownership_suite(
    batch.traces,
    broken_revocation~,
  )
  @runner.cleanup(batch.temp_dir)
  match result {
    Ok(summary) =>
      println(
        "Quint Connect asset replay passed: \{summary.traces_checked} traces, \{summary.states_checked} states matched (seed \{seed})",
      )
    Err(TraceFailed(trace_index, error)) =>
      abort(
        "Quint Connect asset replay diverged in trace \{trace_index}: \{@debug.to_string(error)} (seed \{seed})",
      )
    Err(EmptySuite) =>
      abort("Quint Connect generated an empty asset trace suite")
  }
}
