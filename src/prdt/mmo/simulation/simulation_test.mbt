///|
test "three replicas converge after reorder, duplication, partition, and restart for every seed" {
  let mut partitions = 0
  let mut duplicates = 0
  let mut restarts = 0
  let mut closures = 0
  let mut late = 0
  for seed in 1..<=40 {
    let report = run_mmo_simulation(seed~)
    assert_eq(report.protocol_errors, [])
    assert_true(report.converged)
    assert_true(
      report.state_hashes.iter().all(fn(h) { h == report.state_hashes[0] }),
    )
    for ticks in report.committed_ticks {
      assert_eq(ticks, report.committed_ticks[0])
    }
    partitions += report.counters.partitions
    duplicates += report.counters.duplicates
    restarts += report.counters.restarts
    closures += report.counters.closures
    late += report.counters.late_commands
  }
  assert_true(partitions > 0)
  assert_true(duplicates > 0)
  assert_true(restarts > 0)
  assert_true(closures > 0)
  assert_true(late > 0)
}

///|
test "simulation is reproducible by seed" {
  assert_eq(run_mmo_simulation(seed=7), run_mmo_simulation(seed=7))
}
