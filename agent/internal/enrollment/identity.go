// Package enrollment owns local private keys. No private key leaves the host.
package enrollment

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

type Identity struct {
	MachineIdentityGeneration string       `json:"machine_identity_generation,omitempty"`
	MachineID                 string       `json:"machine_id"`
	CertificateFile           string       `json:"certificate_file"`
	KeyFile                   string       `json:"key_file"`
	IssuerCAFile              string       `json:"issuer_ca_file"`
	ExpiresAt                 string       `json:"expires_at"`
	Serial                    string       `json:"serial"`
	DispatchKey               *DispatchKey `json:"dispatch_key"`
	DispatchEpoch             string       `json:"dispatch_epoch"`
}
type DispatchKey struct {
	KeyID        string `json:"key_id"`
	PublicKeyPEM string `json:"public_key_pem"`
}
type Response struct {
	MachineIdentityGeneration string       `json:"machine_identity_generation,omitempty"`
	MachineID                 string       `json:"machine_id"`
	CertificatePEM            string       `json:"certificate_pem"`
	CAPEM                     string       `json:"ca_pem"`
	ExpiresAt                 string       `json:"expires_at"`
	Serial                    string       `json:"serial"`
	DispatchKey               *DispatchKey `json:"dispatch_key"`
	DispatchEpoch             string       `json:"dispatch_epoch"`
}

func BootstrapClient(caFile string) (*http.Client, error) {
	b, e := os.ReadFile(caFile)
	if e != nil {
		return nil, e
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(b) {
		return nil, errors.New("invalid_server_ca")
	}
	return &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots}}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("enrollment_redirect_denied") }}, nil
}
func Load(dir string) (Identity, error) {
	var id Identity
	b, e := os.ReadFile(filepath.Join(dir, "identity.json"))
	if e != nil {
		return id, e
	}
	e = json.Unmarshal(b, &id)
	return id, e
}
func Enroll(ctx context.Context, client *http.Client, endpoint, dir, machine, token string) (Identity, error) {
	return exchange(ctx, client, endpoint, dir, machine, map[string]any{"token": token, "protocol_version": 1})
}
func Rotate(ctx context.Context, client *http.Client, endpoint, dir, machine string) (Identity, error) {
	old, e := Load(dir)
	if e != nil {
		return Identity{}, e
	}
	return exchange(ctx, client, endpoint, dir, machine, map[string]any{"protocol_version": 1, "__expected_generation": old.MachineIdentityGeneration})
}
func exchange(ctx context.Context, client *http.Client, endpoint, dir, machine string, body map[string]any) (Identity, error) {
	var empty Identity
	u, e := url.Parse(endpoint)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return empty, errors.New("enrollment_requires_pinned_https")
	}
	if !filepath.IsAbs(dir) {
		return empty, errors.New("absolute_protected_identity_directory_required")
	}
	if e = os.MkdirAll(dir, 0700); e != nil {
		return empty, e
	}
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		return empty, e
	}
	uri, e := url.Parse("urn:homelab:machine:" + machine)
	if e != nil {
		return empty, e
	}
	csr, e := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: machine}, URIs: []*url.URL{uri}}, key)
	if e != nil {
		return empty, e
	}
	expectedGeneration, _ := body["__expected_generation"].(string)
	delete(body, "__expected_generation")
	body["csr_pem"] = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr}))
	raw, e := json.Marshal(body)
	if e != nil {
		return empty, e
	}
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(raw))
	if e != nil {
		return empty, e
	}
	req.Header.Set("Content-Type", "application/json")
	resp, e := client.Do(req)
	if e != nil {
		return empty, errors.New("certificate_exchange_transport_failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		return empty, fmt.Errorf("certificate_exchange_status_%d", resp.StatusCode)
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if e != nil {
		return empty, e
	}
	var result Response
	if e = json.Unmarshal(b, &result); e != nil {
		return empty, errors.New("invalid_certificate_response")
	}
	if expectedGeneration != "" && result.MachineIdentityGeneration != expectedGeneration {
		return empty, errors.New("certificate_rotation_identity_generation_changed")
	}
	if result.MachineID != machine {
		return empty, errors.New("certificate_machine_mismatch")
	}
	block, _ := pem.Decode([]byte(result.CertificatePEM))
	if block == nil {
		return empty, errors.New("invalid_issued_certificate")
	}
	cert, e := x509.ParseCertificate(block.Bytes)
	if e != nil {
		return empty, e
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(result.CAPEM)) {
		return empty, errors.New("invalid_issuer_ca")
	}
	if _, e = cert.Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); e != nil {
		return empty, fmt.Errorf("issued_certificate_chain_invalid: %w", e)
	}
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok || !pub.Equal(&key.PublicKey) {
		return empty, errors.New("issued_certificate_key_mismatch")
	}
	bound := false
	for _, san := range cert.URIs {
		if san.String() == uri.String() {
			bound = true
		}
	}
	if !bound {
		return empty, errors.New("issued_certificate_identity_mismatch")
	}
	pk, e := x509.MarshalPKCS8PrivateKey(key)
	if e != nil {
		return empty, e
	}
	generation := fmt.Sprintf("identity-%d", time.Now().UnixNano())
	generationDir := filepath.Join(dir, generation)
	if e = os.Mkdir(generationDir, 0700); e != nil {
		return empty, e
	}
	id := Identity{MachineID: machine, CertificateFile: filepath.Join(generationDir, "certificate.pem"), KeyFile: filepath.Join(generationDir, "key.pem"), IssuerCAFile: filepath.Join(generationDir, "issuer-ca.pem"), ExpiresAt: cert.NotAfter.UTC().Format(time.RFC3339), Serial: result.Serial}
	id.DispatchKey = result.DispatchKey
	id.DispatchEpoch = result.DispatchEpoch
	id.MachineIdentityGeneration = result.MachineIdentityGeneration
	for p, data := range map[string][]byte{id.KeyFile: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pk}), id.CertificateFile: []byte(result.CertificatePEM), id.IssuerCAFile: []byte(result.CAPEM)} {
		if e = write(p, data); e != nil {
			return empty, e
		}
	}
	meta, _ := json.Marshal(id)
	if e = write(filepath.Join(dir, "identity.next.json"), meta); e != nil {
		return empty, e
	}
	if e = os.Rename(filepath.Join(dir, "identity.next.json"), filepath.Join(dir, "identity.json")); e != nil {
		return empty, e
	}
	return id, nil
}
func write(path string, b []byte) error {
	f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	if _, e = f.Write(b); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	return f.Close()
}
