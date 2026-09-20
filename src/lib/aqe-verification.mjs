// A backend smoke, corpus compatibility and storage availability are distinct.
export function aqeVerificationPassed(startup, live) {
  return ['observed', 'busy'].includes(startup.status) && live.status === 'passed'
    && ['healthy', 'empty'].includes(live.corpus?.status);
}
