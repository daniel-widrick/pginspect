package update

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// maxExtractBytes bounds what one archive entry may expand to. A release
// binary is a few tens of megabytes; an archive that decompresses past this
// is not one of ours, and the download was already checked against the
// signed checksums before it got here.
const maxExtractBytes = 512 << 20

// copyBounded copies at most maxExtractBytes and reports an archive that
// tries to go past it, rather than filling the disk with a decompression
// bomb.
func copyBounded(dst io.Writer, src io.Reader) error {
	n, err := io.Copy(dst, io.LimitReader(src, maxExtractBytes+1))
	if err != nil {
		return err
	}
	if n > maxExtractBytes {
		return fmt.Errorf("archive entry exceeds %d bytes", maxExtractBytes)
	}
	return nil
}

// untarBinary extracts the first regular file from a .tar.gz into dir and
// returns its path.
func untarBinary(path, dir string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		dest := filepath.Join(dir, filepath.Base(h.Name))
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return "", err
		}
		err = copyBounded(out, tr)
		out.Close()
		if err != nil {
			return "", err
		}
		return dest, nil
	}
	return "", errors.New("archive holds no file")
}
