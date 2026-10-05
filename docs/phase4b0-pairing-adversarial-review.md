# V1 pairing: adversarial review

Reviewed the current implementation, frozen format, shared codecs/root helpers,
and actual working-tree changes as an attacker. This review adds no relay, D1,
QR/UI, storage integration or protocol version. Existing v1 vectors are unchanged.

## Findings and exact fixes

### HIGH

No new HIGH implementation defect was demonstrated under the approved honest-client
and physical-comparison assumptions. A HIGH conditional attack **was demonstrated**:
if the caller falsely declares that codes were compared, an active two-key MITM
can receive the root and forward it to the intended new device. This is an explicit
violation of the required ceremony, not a silent approval path in the crypto core.
The future UI must never call approvePairing with its own code automatically.
Hostile client JavaScript remains an accepted HIGH threat boundary.

### MEDIUM: observed expiry could be reversed (fixed)

A concrete test withheld a valid provisioning envelope, advanced wall time to
expiry, observed rejection, then restored wall time while the monotonic deadline
had not yet elapsed. Before the fix, opening succeeded and returned M. The expiry
check threw without recording a terminal state. An active trusted context could
similarly become capable of sealing after an observed expiry and clock correction.

stateOf now permanently marks the context failed when its clock/lifetime check
fails. Wall-clock rollback cannot restore it. Regression tests cover both opening
and sealing, in addition to existing expiry-during-decryption tests.

### MEDIUM: bounds were checked after allocation (fixed)

Derivation cloned the entire incoming transcript before validating its 830-byte
maximum. Encoding converted the whole origin to UTF-8 before checking its bound.
A malicious relay supplying oversized data could cause avoidable memory/CPU work
before rejection. Instrumented constructor/encoder tests failed against the old
code, proving the ordering rather than simply checking an eventual exception.

Input type/length is now checked before transcript copying; origin character
length is checked before encoding/URL parsing, followed by the existing UTF-8
byte and canonical-origin checks. Valid wire format and vectors do not change.
Upstream transport must still bound incoming responses; this library cannot avoid
memory the caller already allocated or defend against arbitrary hostile JavaScript.

### LOW: unnecessary local secret retention/copies (reduced)

After derivation, the ephemeral handle retained a private CryptoKey it no longer
needed. The module now drops that reference on success or failure. Shared-secret
operations capture their needed reference before awaiting, so already-running
operations are not broken. The handle remains bound and cannot be reused.

Trusted-side root validation previously serialized and decoded a root bundle just
to verify keyCheck, adding plaintext copies. It now validates the already-owned
root/descriptor directly before constructing the encryption bundle. Existing vectors
and invalid-root tests confirm identical cryptographic behavior.

## Concrete active MITM test

The test generates four independent native P-256 pairs: honest N, honest T,
attacker A pretending to be N, and attacker B pretending to be T. It creates
separate transcripts/channels N–B and A–T, preserving the other public context.
N's SAS equals B's; T's equals A's; the two honest devices' SAS values differ.

Mallory A produces a valid ready MAC for T. T accepts that MAC, but physical
comparison against N's code fails and root sealing remains forbidden. This proves
that a MAC authenticates a channel key holder, not the intended human/device.
There is no internal call that sets approval automatically; the explicit caller
approval action is required for signing ready/opening, and for trusted root sealing.

The same test then deliberately lies about physical comparison at both honest
endpoints. T releases to A; A decrypts M; B encrypts/forwards M to N. The attack
succeeds exactly when the external physical-authentication assumption is violated.
This documents why self-comparison, comparison of server text, or merely seeing a
ready MAC is insufficient. The future trusted scanner must also pin the exact
PN/NN/origin/context from the physical QR, as required by the approved design.

## SAS security: what was and was not established

Code inspection confirms that SAS IKM is native ECDH Z from a local private key;
public transcript hash supplies salt/context, not IKM. Tests independently compare
actual ready MACs with Node HMAC/HKDF, vary security-critical fields while keeping
test ECDH fixed, and show a public-only zero-IKM guess gives unrelated SAS output.
This is a data-flow/behavior check, not a proof that computational DH is secure.

For one fixed independent pair of substituted channels, assuming the KDF behaves
pseudorandomly, equal 60-bit SAS values have probability 2^-60. Our concrete two-key
test obtains different values; a finite test cannot measure that tail probability.
It would be misleading to turn this into an unconditional 60-bit active-MITM
work-factor claim.

**MEDIUM residual protocol concern, not resolved by a speculative rewrite:** if
both public-key choices are unconstrained after seeing both honest public values,
an attacker can search two sets of candidate SAS outputs. In a generic independent
model, success scales with qA*qB/2^60, allowing a birthday-style order-2^30 search
per side rather than a single-target order-2^60 search. This is an inference about
an unrestricted two-sided chosen-key model, not a measured full attack against
this application's five-minute ceremony.

[RFC 6189 section 4.4.1.1](https://www.rfc-editor.org/rfc/rfc6189.html#section-4.4.1.1)
describes the general short-SAS chosen-key/birthday issue and the role of commitments.
AEGIS v1 instead requires authentic out-of-band QR pinning of the new public key,
which would reject substituted PN before this two-sided model applies. The crypto
core alone does not perform that pinning. Actual QR/offer timing, enforcement and
full 60-bit grinding feasibility within five minutes are not verified locally.
No commitment, longer SAS, suite change or relay implementation was invented here.
Before integration, independently review those assumptions; do not advertise SAS
alone as providing a proven 60-bit work factor against adaptive key selection.

## Attack coverage

| Attack | Result / basis |
| --- | --- |
| PN/PT substitution, cross-session public-key swap | Wrong local role key rejects; different honest SAS; actual HMAC rejects in active state |
| Swap pairId, NN/NT, vault/epoch, descriptor hash, origin, created/expiry | Full transcript hash, SAS and HKDF purpose keys change; MAC/envelope replay rejects |
| Old ready/consumed MAC in a new pairing | Rejects, including fixed test ECDH with changed pairId only |
| Old envelope/new pairId, simultaneous envelope swap | Rejects AEAD/context and returns no root |
| Cross-vault, cross-epoch, cross-origin envelope | Rejects, with shared test master intentionally held equal |
| Same envelope opened twice, failure then retry | Single-use opening and failed context reject |
| Reflection, role reversal, ready-as-consumed/consumed-as-ready | Role/phase gates, purpose labels and exact sealed-response hash reject |
| Reorder open/ready/consume | Approval/ready/open-completion gates reject |
| Race ephemeral derivation, seal/open, approve/open/consume | Synchronous reservations permit one operation; premature consumes/approval reject |
| Withhold then deliver after expiry/clock rollback | Terminal failed state rejects; cannot revive |
| Duplicate messages | Ready duplicates only while active; exact consumed ACK retries remain intentionally idempotent, never release a second root |
| Non-HTTPS, empty/huge, path/query/fragment, credentials, default-port/case origins | Canonical parser/bounds reject; different valid origin changes binding |
| Truncated/compressed/hybrid/off-curve points | Representation or native curve import rejects |
| Bad lengths, unsafe/fractional/negative timestamps, lifetime !=300, trailing/version/suite bytes | Parser or live-context validation rejects before root release |

Parser and cryptographic rejection are distinguished: a valid but different origin
is not globally forbidden; it is a different context, and old messages fail.
The caller must independently bind its actual trusted origin/descriptor. QR-based
expectation checking and relay state are outside this task.

## Secret lifetime and remaining limitations

Raw ECDH Z and derived raw AES/HMAC/SAS buffers are cleared after derivation;
private-key references are dropped. Immutable input snapshots deliberately defend
against mutable-view races. Caller-owned scratch from deriveSharedSecret must be
cleared by the caller; it is not serialized. Ciphertext, public points and hashes
are public data. No secret-bearing logs/errors were found or introduced.

Provisioning uses one fresh IV/one sealing operation per context. Root plaintext
buffers are cleared on failure and after encryption; successful recovered M is
returned only after AEAD, keyCheck, identity, descriptor hash, state and expiry
checks. The caller must protect/clear the successful result as appropriate.
Native derived keys remain inside opaque contexts until their handles are dropped.
JavaScript GC, native crypto operations, register copies and caller references
prevent a guarantee of physical memory wiping. No such guarantee is claimed.

Availability against a malicious relay, truthful physical comparison, trustworthy
client code/native Web Crypto, QR context pinning, device compromise, clock behavior
and independent protocol review remain assumptions. No browser or production relay
security claim is made. Replaying identical consumed acknowledgements in their own
completed live context is deliberate; old acknowledgements across contexts fail.

## Scope and verification

The actual pairing source diff and complete working-tree status were inspected.
The source fixes preserve the frozen format and existing deterministic vector
bytes. All old item/file/recovery/auth/storage tests remain in the required suite,
with new adversarial tests in tests/pairing-adversarial.test.mjs. No production UI,
Worker, D1/R2, resources, commits or pushes were changed by this review.
