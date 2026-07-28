# Trickle ICE test report

## Root cause addressed

The previous implementation waited up to 10 seconds for ICE gathering and then sent only the current SDP. On mobile/mixed browser combinations candidates can be gathered incrementally or after that send point. The receiver then has no usable candidate pair and reaches `connectionState=failed`.

## Changes validated

- Offer and answer are sent immediately after `setLocalDescription`.
- Every ICE candidate is persisted as a separate `ice-candidate` signal.
- End-of-candidates is transmitted.
- Candidates are buffered until the corresponding SDP has been signalled.
- Candidates are scoped by a random negotiation ID, preventing stale restart candidates from entering a newer negotiation.
- Remote candidates are queued until `remoteDescription` is installed.
- ICE restart is bounded to two attempts.
- Diagnostics distinguish no remote candidates, host-only/client-isolation scenarios, and general NAT/UDP failure.

## Automated results

`node --no-warnings --experimental-strip-types --test tests/*.test.ts`

Result: 16 passed, 0 failed.

## Static checks

- Strict TypeScript check for WebRTC core: passed.
- Strict isolated TypeScript check for the updated React hook: passed.

## Remaining network limitation

A direct WebRTC connection can still fail when a Wi-Fi access point isolates clients, UDP is blocked, or NAT hairpin/direct paths are unavailable. Those cases require TURN. This patch makes candidate delivery correct and exposes enough diagnostics to distinguish those network cases from a signaling bug.
