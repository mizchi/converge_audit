// Healthy and deliberately broken external-arbiter appeal configurations.
module lineageAppealSafety {
  import lineageAppeal(
    enforceAuthentication = true,
    enforceCertificateTime = true,
    enforceRevisionAdvance = true,
    enforceAppealTarget = true,
    enforceAppealDeadline = true
  ).* from "./LineageAppeal"
}

module lineageAppealBrokenAuthentication {
  import lineageAppeal(
    enforceAuthentication = false,
    enforceCertificateTime = true,
    enforceRevisionAdvance = true,
    enforceAppealTarget = true,
    enforceAppealDeadline = true
  ).* from "./LineageAppeal"
}

module lineageAppealBrokenCertificateTime {
  import lineageAppeal(
    enforceAuthentication = true,
    enforceCertificateTime = false,
    enforceRevisionAdvance = true,
    enforceAppealTarget = true,
    enforceAppealDeadline = true
  ).* from "./LineageAppeal"
}

module lineageAppealBrokenRevision {
  import lineageAppeal(
    enforceAuthentication = true,
    enforceCertificateTime = true,
    enforceRevisionAdvance = false,
    enforceAppealTarget = true,
    enforceAppealDeadline = true
  ).* from "./LineageAppeal"
}

module lineageAppealBrokenTarget {
  import lineageAppeal(
    enforceAuthentication = true,
    enforceCertificateTime = true,
    enforceRevisionAdvance = true,
    enforceAppealTarget = false,
    enforceAppealDeadline = true
  ).* from "./LineageAppeal"
}

module lineageAppealBrokenDeadline {
  import lineageAppeal(
    enforceAuthentication = true,
    enforceCertificateTime = true,
    enforceRevisionAdvance = true,
    enforceAppealTarget = true,
    enforceAppealDeadline = false
  ).* from "./LineageAppeal"
}
