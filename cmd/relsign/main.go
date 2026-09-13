// Command relsign signs a release checksums file with the project's Ed25519
// release key, and can generate a key pair.
//
//	relsign -gen                       prints a new key pair
//	relsign -key <seed> checksums.txt  writes checksums.txt.sig
//
// The private key is the 32-byte Ed25519 seed, base64; CI reads it from the
// RELEASE_SIGNING_KEY secret. The matching public key is embedded in the
// app (internal/update/key.go) and is the only thing an update is trusted
// against.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"os"
)

func main() {
	gen := flag.Bool("gen", false, "generate a key pair")
	key := flag.String("key", os.Getenv("RELEASE_SIGNING_KEY"), "base64 Ed25519 seed (default $RELEASE_SIGNING_KEY)")
	flag.Parse()

	if *gen {
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			fatal(err)
		}
		fmt.Printf("private seed: %s\npublic key:   %s\n", base64.StdEncoding.EncodeToString(priv.Seed()), base64.StdEncoding.EncodeToString(pub))
		return
	}
	if flag.NArg() != 1 || *key == "" {
		fatal(fmt.Errorf("usage: relsign -key <seed> <file>"))
	}
	seed, err := base64.StdEncoding.DecodeString(*key)
	if err != nil || len(seed) != ed25519.SeedSize {
		fatal(fmt.Errorf("invalid signing key"))
	}
	priv := ed25519.NewKeyFromSeed(seed)
	data, err := os.ReadFile(flag.Arg(0))
	if err != nil {
		fatal(err)
	}
	sig := ed25519.Sign(priv, data)
	out := flag.Arg(0) + ".sig"
	if err := os.WriteFile(out, []byte(base64.StdEncoding.EncodeToString(sig)+"\n"), 0o644); err != nil {
		fatal(err)
	}
	fmt.Println("wrote", out)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "relsign:", err)
	os.Exit(1)
}
