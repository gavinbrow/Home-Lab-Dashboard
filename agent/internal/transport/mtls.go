package transport

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"
)

// MTLSClient never falls back to bearer auth or disables peer verification.
func MTLSClient(caFile, certFile, keyFile string) (*http.Client, error) {
	ca, e := os.ReadFile(caFile)
	if e != nil {
		return nil, e
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		return nil, errors.New("invalid_ca")
	}
	cert, e := tls.LoadX509KeyPair(certFile, keyFile)
	if e != nil {
		return nil, e
	}
	return &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots, Certificates: []tls.Certificate{cert}}}, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("agent_redirect_denied") }}, nil
}
func Post(ctx context.Context, client *http.Client, endpoint string, v any) error {
	u, e := url.Parse(endpoint)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("explicit_https_endpoint_required")
	}
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(b))
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	resp, e := client.Do(req)
	if e != nil {
		return errors.New("agent_transport_failed")
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("agent_endpoint_status_%d", resp.StatusCode)
	}
	return nil
}
