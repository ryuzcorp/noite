### Changed

- In multi tenancy (`NOITE_TENANCY=multi`) the Void proxy's SMTP relay (`NOITE_VOID_SMTP_HOST`) and AI endpoints (`NOITE_VOID_AI_MODELS`) must be publicly reachable: the proxy runs inside the tenant fleet, whose egress policy rejects loopback and private destinations. Loopback, private, link-local, CGNAT and ULA addresses — and obviously local names (`localhost`, `*.local`, `*.internal`, single-label names) — now fail the boot naming the var instead of answering 502/`UPSTREAM_ERROR` at send time. `NOITE_VOID_AI_ALLOW_PLAINTEXT=1` (loopback `http` sidecars) is inert in multi; single-tenancy installs are unchanged.

### Operator action required

- If a multi-tenancy install points `NOITE_VOID_SMTP_HOST` or an AI endpoint at internal infrastructure (a private IP, `localhost`, a `.local`/`.internal` name), move it to a publicly reachable address before upgrading — the new boot check refuses the old value naming the var.
