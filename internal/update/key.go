package update

// ReleasePublicKey is the Ed25519 public key that release checksum files
// are signed with. An update whose checksums file does not verify against
// it is refused. The private seed is held only in the repository's
// RELEASE_SIGNING_KEY secret and the maintainer's key file.
const ReleasePublicKey = "KCT40L40Qz0rxlCCGyAEzo+xLMfrWUb8Y7Czn0R2xCQ="
