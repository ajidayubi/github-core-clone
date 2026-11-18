// forge is one process that serves a GitHub-compatible git forge: git smart
// HTTP, REST v3, GraphQL v4 and MCP, all over a deterministic in-memory store.
//
// It binds an ephemeral port (or the one named by --port / PORT), prints
// PORT=<n> on stdout once it is listening, and exits when it is signalled.
// The entrypoint main.ts spawns this binary and drives the lifecycle.
package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	port := 0
	for i := 1; i < len(os.Args); i++ {
		a := os.Args[i]
		if a == "--port" && i+1 < len(os.Args) {
			i++
			n, err := strconv.Atoi(os.Args[i])
			if err == nil {
				port = n
			}
		} else if strings.HasPrefix(a, "--port=") {
			n, err := strconv.Atoi(strings.TrimPrefix(a, "--port="))
			if err == nil {
				port = n
			}
		}
	}
	if port == 0 {
		if v := os.Getenv("PORT"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				port = n
			}
		}
	}
	initStore()

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		fmt.Fprintf(os.Stderr, "forge: listen: %v\n", err)
		os.Exit(1)
	}
	addr := ln.Addr().(*net.TCPAddr)
	fmt.Printf("PORT=%d\n", addr.Port)
	_ = os.Stdout.Sync()

	srv := &http.Server{
		Handler:      http.HandlerFunc(dispatch),
		ReadTimeout:  120 * time.Second,
		WriteTimeout: 120 * time.Second,
	}
	go func() {
		_ = srv.Serve(ln)
	}()

	// Wait for SIGTERM/SIGINT (the entrypoint kills us when the trial ends).
	ch := make(chan os.Signal, 2)
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
	<-ch
	_ = srv.Close()
}
